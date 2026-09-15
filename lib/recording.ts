// Portable v1 format: one session line followed by ordered checkpoint events.
// A file replacement is a reversible patch; text and hashes travel together.
export const RECORDING_MAX_BYTES = 20 * 1024 * 1024;
export const RECORDING_MAX_EVENTS = 2000;
export const RECORDING_MAX_FILE_BYTES = 256 * 1024;

export interface RecordedFile { content: string; sha256: string }
export interface RecordedChange { path: string; before: RecordedFile | null; after: RecordedFile | null }
export interface RecordingSession {
  type: "session";
  format: "chronosphere.recording";
  version: 1;
  id: string;
  createdAt: string;
  title: string;
  capture: "checkpoints";
  repository: { name: string; head: string | null; branch: string | null };
  scope: string[];
  baseline: Record<string, RecordedFile>;
  omitted: Array<{ path: string; reason: string }>;
}
export interface RecordingEvent {
  type: "change" | "command" | "finish";
  id: string;
  sequence: number;
  recordedAt: string;
  title: string;
  reason: string;
  changes: RecordedChange[];
  omitted: Array<{ path: string; reason: string }>;
  command?: { argv: string[]; exitCode: number | null; signal: string | null; output: string; truncated: boolean };
}
export interface Recording { session: RecordingSession; events: RecordingEvent[] }

export async function contentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a recording object.");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 8000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Missing or invalid recording text.");
}
function path(value: unknown): asserts value is string {
  string(value, 4096);
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === ".." || part === ".") || /[\x00-\x1f]/.test(value)) throw new Error("Invalid recording file path.");
}
function timestamp(value: unknown) {
  string(value, 100);
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid recording timestamp.");
}
function omissions(value: unknown) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Invalid omitted-file list.");
  for (const item of value) { const entry = object(item); path(entry.path); string(entry.reason); }
}
function same(a: RecordedFile | null, b: RecordedFile | null) {
  return a === null ? b === null : b !== null && a.sha256 === b.sha256 && a.content === b.content;
}

/** Validate untrusted imports, including every content hash and patch precondition. */
export async function parseRecording(source: string): Promise<Recording> {
  if (new TextEncoder().encode(source).length > RECORDING_MAX_BYTES) throw new Error("Recording exceeds the 20 MB import limit.");
  const lines = source.trimEnd().split("\n");
  if (lines.length > RECORDING_MAX_EVENTS + 1) throw new Error("Recording has too many events.");
  let records: unknown[];
  try { records = lines.map((line) => JSON.parse(line)); }
  catch { throw new Error("Invalid JSONL recording. A line may be incomplete; use the original recording file."); }
  const header = object(records[0]);
  if (header.type !== "session" || header.format !== "chronosphere.recording" || header.version !== 1 || header.capture !== "checkpoints") throw new Error("Unsupported recording format. Expected Chronosphere recording v1.");
  string(header.id); string(header.title); timestamp(header.createdAt);
  const repo = object(header.repository);
  string(repo.name);
  for (const field of [repo.head, repo.branch]) if (field !== null) string(field);
  if (!Array.isArray(header.scope) || !header.scope.length) throw new Error("Missing recording scope.");
  for (const entry of header.scope) { if (entry !== ".") path(entry); }
  omissions(header.omitted);
  const seenHashes = new Map<string, string>();
  async function file(value: unknown): Promise<RecordedFile | null> {
    if (value === null) return null;
    const data = object(value);
    if (typeof data.content !== "string" || new TextEncoder().encode(data.content).length > RECORDING_MAX_FILE_BYTES || typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error("Invalid recorded file.");
    if (seenHashes.get(data.sha256) !== data.content && await contentHash(data.content) !== data.sha256) throw new Error("Recording content hash does not match its text.");
    seenHashes.set(data.sha256, data.content);
    return { content: data.content, sha256: data.sha256 };
  }
  const state = new Map<string, RecordedFile>();
  const baseline = object(header.baseline);
  for (const [name, value] of Object.entries(baseline)) {
    path(name);
    const data = await file(value);
    if (!data) throw new Error("Baseline files cannot be null.");
    state.set(name, data);
  }
  const ids = new Set<string>([header.id]);
  let finished = false;
  for (let index = 1; index < records.length; index++) {
    const entry = object(records[index]);
    if (finished || !["change", "command", "finish"].includes(entry.type as string) || entry.sequence !== index) throw new Error("Recording events are missing, reordered, or follow a finished session.");
    string(entry.id); string(entry.title); string(entry.reason); timestamp(entry.recordedAt); omissions(entry.omitted);
    if (ids.has(entry.id)) throw new Error("Duplicate recording event ID.");
    ids.add(entry.id);
    if (!Array.isArray(entry.changes)) throw new Error("Missing event changes.");
    const touched = new Set<string>();
    for (const raw of entry.changes) {
      const change = object(raw);
      path(change.path);
      if (touched.has(change.path)) throw new Error("Duplicate file in a checkpoint.");
      touched.add(change.path);
      const before = await file(change.before), after = await file(change.after);
      if (!same(state.get(change.path) ?? null, before)) throw new Error(`Patch does not match prior state: ${change.path}`);
      if (same(before, after)) throw new Error("Recording contains an empty file change.");
      if (after) state.set(change.path, after); else state.delete(change.path);
    }
    if (entry.type === "command") {
      const command = object(entry.command);
      if (!Array.isArray(command.argv) || !command.argv.length || !command.argv.every((arg) => typeof arg === "string") || !(command.exitCode === null || Number.isInteger(command.exitCode)) || !(command.signal === null || typeof command.signal === "string") || typeof command.output !== "string" || command.output.length > 40000 || typeof command.truncated !== "boolean") throw new Error("Invalid command result.");
    } else if (entry.command !== undefined) throw new Error("Unexpected command result.");
    finished = entry.type === "finish";
  }
  return { session: header as unknown as RecordingSession, events: records.slice(1) as RecordingEvent[] };
}

/** Index zero is the baseline; later indexes include that many events. */
export function recordingStateAt(recording: Recording, index: number): Map<string, RecordedFile> {
  const state = new Map(Object.entries(recording.session.baseline));
  for (const event of recording.events.slice(0, Math.max(0, index))) {
    for (const change of event.changes) {
      if (change.after) state.set(change.path, change.after); else state.delete(change.path);
    }
  }
  return state;
}

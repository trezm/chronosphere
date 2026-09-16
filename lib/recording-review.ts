import type { DiffFile, DiffLine, PendingComment, ReplayResult } from "./types";
import type { RecordedChange, Recording, RecordingEvent } from "./recording";

export type ReviewAnchor = Pick<PendingComment, "path" | "line" | "side">;

/** Persist only the timeline metadata, never the uploaded workspace snapshots. */
export function recordingReplay(recording: Recording, name: string): ReplayResult {
  return {
    source: "recording", recordingId: recording.session.id, recordingName: name,
    model: "Recorded checkpoints", truncated: false,
    chunks: [
      { title: "Starting snapshot", description: `Recording began with ${Object.keys(recording.session.baseline).length} text files. Earlier edits are not recorded.`, ranges: [], files: [] },
      ...recording.events.map((event) => ({ title: event.title, description: event.reason, ranges: [], files: event.changes.map((change) => change.path) })),
    ],
  };
}

function lines(content: string | undefined): string[] {
  if (!content) return [];
  const values = content.replace(/\r\n/g, "\n").split("\n");
  if (values.at(-1) === "") values.pop();
  return values;
}

/** A bounded, exact replacement hunk. Unchanged prefix/suffix are context. */
export function recordedChangeDiff(change: RecordedChange): DiffFile {
  const before = lines(change.before?.content), after = lines(change.after?.content);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3);
  const rows: DiffLine[] = [];
  let changedIndex = 0;
  for (let i = start; i < prefix; i++) rows.push({ type: "context", text: before[i], oldLine: i + 1, newLine: i + 1, changedIndex: null });
  for (let i = prefix; i < before.length - suffix; i++) rows.push({ type: "delete", text: before[i], oldLine: i + 1, newLine: null, changedIndex: ++changedIndex });
  for (let i = prefix; i < after.length - suffix; i++) rows.push({ type: "add", text: after[i], oldLine: null, newLine: i + 1, changedIndex: ++changedIndex });
  for (let i = 0; i < Math.min(3, suffix); i++) rows.push({ type: "context", text: after[after.length - suffix + i], oldLine: before.length - suffix + i + 1, newLine: after.length - suffix + i + 1, changedIndex: null });
  const oldCount = rows.filter((row) => row.oldLine !== null).length;
  const newCount = rows.filter((row) => row.newLine !== null).length;
  return {
    path: change.path, oldPath: null,
    status: change.before === null ? "added" : change.after === null ? "deleted" : "modified",
    hunks: rows.length ? [{ header: `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@`, lines: rows }] : [],
  };
}

/** Anchor only verified whole-file versions, and only lines present in the PR diff. */
export function recordedLineAnchor(
  change: RecordedChange, line: DiffLine, canonical: DiffFile | undefined,
  verified: { baseHash?: string; headHash?: string },
): ReviewAnchor | null {
  if (!canonical) return null;
  const candidates = canonical.hunks.flatMap((hunk) => hunk.lines);
  if (line.type !== "delete" && line.newLine !== null && change.after?.sha256 === verified.headHash
    && candidates.some((row) => row.newLine === line.newLine && row.type !== "delete" && row.text === line.text)) {
    return { path: canonical.path, line: line.newLine, side: "RIGHT" };
  }
  if (line.type !== "add" && line.oldLine !== null && change.before?.sha256 === verified.baseHash
    && candidates.some((row) => row.oldLine === line.oldLine && row.type !== "add" && row.text === line.text)) {
    return { path: canonical.path, line: line.oldLine, side: "LEFT" };
  }
  return null;
}

export function historicalReviewNote(event: Pick<RecordingEvent, "title" | "sequence" | "id">, path: string, line: number, side: string, body: string): string {
  return `Recorded step ${event.sequence}: ${event.title}\nFile: ${path}:${line} (${side === "LEFT" ? "before" : "after"}; historical version, event ${event.id})\n\n${body.trim()}`;
}

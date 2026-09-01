import type { ReplayResult } from "./types";

/**
 * Newline-delimited JSON events streamed by POST /api/replay.
 *
 * The server emits throttled `progress` events while the model output
 * accumulates, one `parsing` event once the output is complete and the steps
 * are being ordered, and exactly one terminal `done` or `error` event.
 */
export type ReplayStreamEvent =
  | { type: "progress"; chars: number }
  | { type: "parsing" }
  | { type: "done"; replay: ReplayResult }
  | { type: "error"; error: string };

/** One frame of an OpenRouter server-sent event stream. */
export type OpenRouterFrame = { content: string } | { error: OpenRouterError };

/** Diagnostic fields OpenRouter attaches to an error, before or mid-stream. */
export interface OpenRouterErrorDetails {
  /** HTTP status of a non-2xx response; absent for mid-stream error frames. */
  status?: number;
  /** OpenRouter's own error code, numeric or symbolic (e.g. 500, "server_error"). */
  code?: string | number;
  /** Upstream provider that failed, when OpenRouter names one. */
  provider?: string;
  /** Raw upstream error body, when OpenRouter forwards one. */
  raw?: string;
  /** X-Generation-Id of the request, for correlating with OpenRouter's logs. */
  generationId?: string;
}

/** Longest raw upstream error kept in the user-facing message. */
const RAW_SNIPPET_CHARS = 200;

function asText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * An OpenRouter failure with its diagnostic fields kept alongside the message,
 * so the route can log the whole picture instead of one sentence.
 */
export class OpenRouterError extends Error {
  readonly status?: number;
  readonly code?: string | number;
  readonly provider?: string;
  readonly raw?: string;
  generationId?: string;

  constructor(message: string | undefined, details: OpenRouterErrorDetails = {}) {
    super(describeOpenRouterError(message, details));
    this.name = "OpenRouterError";
    this.status = details.status;
    this.code = details.code;
    this.provider = details.provider;
    this.raw = details.raw;
    this.generationId = details.generationId;
  }

  /** Flat, JSON-safe view of the failure for structured logs. */
  details(): Record<string, string | number | undefined> {
    return { message: this.message, status: this.status, code: this.code, provider: this.provider, raw: this.raw, generationId: this.generationId };
  }
}

/** Builds the user-facing sentence: the message, then whatever OpenRouter blamed. */
export function describeOpenRouterError(message: string | undefined, details: OpenRouterErrorDetails = {}): string {
  const own = !message?.trim();
  const base = message?.trim() || (details.status ? `OpenRouter returned ${details.status}` : "OpenRouter reported an error mid-stream");
  const blame = [details.provider, details.code !== undefined && String(details.code) !== String(details.status) ? `code ${details.code}` : undefined].filter(Boolean).join(", ");
  const raw = details.raw && details.raw !== message
    ? details.raw.length > RAW_SNIPPET_CHARS ? `${details.raw.slice(0, RAW_SNIPPET_CHARS)}…` : details.raw
    : undefined;
  const tail = `${blame ? ` (${blame})` : ""}${raw ? `: ${raw}` : ""}`;
  // OpenRouter's own sentences are passed through untouched; ours get a full stop.
  return own && !tail ? `${base}.` : `${base}${tail}`;
}

/** The shape OpenRouter uses for error payloads, both plain JSON and SSE frames. */
export interface OpenRouterErrorPayload {
  error?: { message?: string; code?: string | number; metadata?: { raw?: unknown; provider_name?: string } } | string;
}

/** Reads OpenRouter's error object into an OpenRouterError; null when the payload has none. */
export function openRouterError(payload: OpenRouterErrorPayload | null | undefined, details: OpenRouterErrorDetails = {}): OpenRouterError | null {
  const error = payload?.error;
  if (!error) return null;
  if (typeof error === "string") return new OpenRouterError(error, details);
  return new OpenRouterError(error.message, {
    ...details,
    code: error.code ?? details.code,
    provider: error.metadata?.provider_name ?? details.provider,
    raw: asText(error.metadata?.raw) ?? details.raw,
  });
}

/** Buffers decoded text and releases only the lines that are complete. */
export function lineBuffer() {
  let pending = "";
  return {
    push(text: string): string[] {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      return lines;
    },
    flush(): string[] {
      const rest = pending;
      pending = "";
      return rest ? [rest] : [];
    },
  };
}

async function* decode(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reads one OpenRouter SSE line. Returns null for keep-alive comments, the
 * `[DONE]` sentinel, and frames that carry no content.
 */
export function openRouterFrame(line: string): OpenRouterFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return null;
  let parsed: OpenRouterErrorPayload & {
    choices?: Array<{ delta?: { content?: string | null } }>;
    provider?: string;
  };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    return null;
  }
  const error = openRouterError(parsed, { provider: parsed.provider });
  if (error) return { error };
  const content = parsed.choices?.[0]?.delta?.content;
  return content ? { content } : null;
}

/** Yields the content deltas of an OpenRouter stream, throwing on an error frame. */
export async function* readOpenRouterContent(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const lines = lineBuffer();
  const emit = function* (line: string): Generator<string> {
    const frame = openRouterFrame(line);
    if (!frame) return;
    if ("error" in frame) throw frame.error;
    yield frame.content;
  };
  for await (const text of decode(body)) {
    for (const line of lines.push(text)) yield* emit(line);
  }
  for (const line of lines.flush()) yield* emit(line);
}

/** Reads one newline-delimited replay event, ignoring blank or unrecognised lines. */
export function parseReplayEvent(line: string): ReplayStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: Partial<ReplayStreamEvent> & { chars?: unknown; error?: unknown; replay?: unknown };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.type === "progress" && typeof parsed.chars === "number") return { type: "progress", chars: parsed.chars };
  if (parsed.type === "parsing") return { type: "parsing" };
  if (parsed.type === "done" && parsed.replay) return { type: "done", replay: parsed.replay as ReplayResult };
  if (parsed.type === "error") {
    return { type: "error", error: typeof parsed.error === "string" ? parsed.error : "Could not build the replay." };
  }
  return null;
}

/** Yields the replay events carried by a POST /api/replay response body. */
export async function* readReplayEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ReplayStreamEvent> {
  const lines = lineBuffer();
  for await (const text of decode(body)) {
    for (const line of lines.push(text)) {
      const event = parseReplayEvent(line);
      if (event) yield event;
    }
  }
  for (const line of lines.flush()) {
    const event = parseReplayEvent(line);
    if (event) yield event;
  }
}

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
export type OpenRouterFrame = { content: string } | { error: string };

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
  let parsed: {
    choices?: Array<{ delta?: { content?: string | null } }>;
    error?: { message?: string };
  };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.error) return { error: parsed.error.message || "OpenRouter reported an error mid-stream." };
  const content = parsed.choices?.[0]?.delta?.content;
  return content ? { content } : null;
}

/** Yields the content deltas of an OpenRouter stream, throwing on an error frame. */
export async function* readOpenRouterContent(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const lines = lineBuffer();
  const emit = function* (line: string): Generator<string> {
    const frame = openRouterFrame(line);
    if (!frame) return;
    if ("error" in frame) throw new Error(frame.error);
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

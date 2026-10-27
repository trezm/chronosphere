import { NextRequest } from "next/server";
import { withoutRecordingDiff } from "@/lib/pr-recording";
import { githubFetch, githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import { buildReplay, ReplayOutputError } from "@/lib/replay";
import { OpenRouterError, type ReplayStreamEvent } from "@/lib/replay-stream";
import { readSession } from "@/lib/session";
import type { PullRequestDetail } from "@/lib/types";

export const maxDuration = 120;

/** Roughly three progress events per second: alive to watch, cheap to send. */
const PROGRESS_INTERVAL_MS = 300;

/**
 * One JSON line per failure so Railway's log explorer can filter on the
 * fields. Everything OpenRouter told us travels along: status, code, provider,
 * raw upstream body, and the generation id to look the request up on their side.
 */
function logReplayFailure(error: unknown, context: { repo: string; number: number; model?: string; elapsedMs: number }) {
  const base = { level: "error", event: "replay.failed", ...context, error: error instanceof Error ? error.message : String(error) };
  const detail = error instanceof OpenRouterError
    ? { kind: "openrouter", ...error.details() }
    : error instanceof ReplayOutputError
      ? { kind: "model-output", output: error.snippet(), cause: error.cause instanceof Error ? error.cause.message : undefined, generationId: (error as { generationId?: string }).generationId }
      : { kind: error instanceof Error ? error.name : typeof error, generationId: (error as { generationId?: string })?.generationId, stack: error instanceof Error ? error.stack : undefined };
  console.error(JSON.stringify({ ...base, ...detail }));
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let context: { repo: string; number: number; model?: string } | null = null;
  try {
    const session = await readSession(request);
    const apiKey = session.openrouter?.apiKey;
    if (!apiKey) throw new Error("OpenRouter authentication is required.");
    const token = await githubToken(request);
    const input = (await request.json()) as { repo?: string; number?: number; model?: string; layout?: string };
    const { fullName } = parseRepo(input.repo ?? null);
    const number = parsePullNumber(input.number);
    context = { repo: fullName, number, model: input.model?.trim() || undefined };
    const [pull, diffResponse] = await Promise.all([
      githubJson<{
        number: number; title: string; body: string | null;
        user: { login: string; avatar_url: string };
        base: { ref: string }; head: { ref: string };
      }>(token, `/repos/${fullName}/pulls/${number}`),
      githubFetch(token, `/repos/${fullName}/pulls/${number}`, { headers: { Accept: "application/vnd.github.v3.diff" } }),
    ]);
    const detail = {
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      author: { login: pull.user.login, avatarUrl: pull.user.avatar_url },
      base: pull.base.ref,
      head: pull.head.ref,
      diff: withoutRecordingDiff(await diffResponse.text()),
    } as Pick<PullRequestDetail, "number" | "title" | "body" | "author" | "base" | "head" | "diff">;
    // Request validation and the GitHub round trip stay plain JSON errors; once
    // the model call begins the client is reading a stream, so build failures
    // travel as a terminal error event instead.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const send = (event: ReplayStreamEvent) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            open = false; // The client hung up mid-build.
          }
        };
        let lastProgress = 0;
        try {
          const replay = await buildReplay(detail, apiKey, {
            model: input.model,
            layout: input.layout === "tree" ? "tree" : undefined,
            signal: request.signal,
            onProgress: (chars) => {
              const now = Date.now();
              if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
              lastProgress = now;
              send({ type: "progress", chars });
            },
            onParse: () => send({ type: "parsing" }),
          });
          send({ type: "done", replay });
        } catch (error) {
          logReplayFailure(error, { repo: fullName, number, model: input.model?.trim() || undefined, elapsedMs: Date.now() - startedAt });
          send({ type: "error", error: error instanceof Error ? error.message : "Could not build the replay." });
        } finally {
          try {
            if (open) controller.close();
          } catch {
            // Already closed by the client disconnecting.
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    // Validation and GitHub failures before the stream opens; the response
    // status says most of it, so log only what the client cannot show.
    console.warn(JSON.stringify({ level: "warn", event: "replay.rejected", ...context, error: error instanceof Error ? error.message : String(error) }));
    return jsonError(error);
  }
}

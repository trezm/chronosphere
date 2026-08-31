import { NextRequest } from "next/server";
import { githubFetch, githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import { buildReplay } from "@/lib/replay";
import type { ReplayStreamEvent } from "@/lib/replay-stream";
import { readSession } from "@/lib/session";
import type { PullRequestDetail } from "@/lib/types";

export const maxDuration = 120;

/** Roughly three progress events per second: alive to watch, cheap to send. */
const PROGRESS_INTERVAL_MS = 300;

export async function POST(request: NextRequest) {
  try {
    const session = await readSession(request);
    const apiKey = session.openrouter?.apiKey;
    if (!apiKey) throw new Error("OpenRouter authentication is required.");
    const token = await githubToken(request);
    const input = (await request.json()) as { repo?: string; number?: number; model?: string };
    const { fullName } = parseRepo(input.repo ?? null);
    const number = parsePullNumber(input.number);
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
      diff: await diffResponse.text(),
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
    return jsonError(error);
  }
}

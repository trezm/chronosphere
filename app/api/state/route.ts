import { NextRequest } from "next/server";
import { deletePullRequestState, loadPullRequestState, savePullRequestState } from "@/lib/review-state-store";
import { isPullRequestState } from "@/lib/review-state";
import { jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import { readSession } from "@/lib/session";

const MAX_STATE_BYTES = 1_500_000;

async function viewerFor(request: NextRequest): Promise<string> {
  const session = await readSession(request);
  if (!session.github?.login) throw new Error("GitHub authentication is required.");
  return session.github.login.toLowerCase();
}

function stateKey(url: URL) {
  const { fullName } = parseRepo(url.searchParams.get("repo"));
  return {
    repository: fullName.toLowerCase(),
    pullNumber: parsePullNumber(url.searchParams.get("number")),
    headSha: url.searchParams.get("headSha")?.trim() ?? "",
  };
}

function validHeadSha(value: string): boolean {
  return /^[a-f0-9]{40,64}$/i.test(value);
}

function stateError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const serverError = /database binding|no such table|D1_ERROR|SQLITE_/i.test(message);
  return jsonError(error, serverError ? 500 : 400);
}

export async function GET(request: NextRequest) {
  try {
    const viewer = await viewerFor(request);
    const { repository, pullNumber, headSha } = stateKey(request.nextUrl);
    if (!validHeadSha(headSha)) throw new Error("A valid pull request head SHA is required.");
    const stored = await loadPullRequestState(viewer, repository, pullNumber, headSha);
    if (!stored || !isPullRequestState(stored.state) || stored.state.headSha !== headSha) {
      if (stored) await deletePullRequestState(viewer, repository, pullNumber, headSha);
      return Response.json({ state: null, revision: 0 });
    }
    return Response.json(stored);
  } catch (error) {
    return stateError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const viewer = await viewerFor(request);
    const input = (await request.json()) as {
      repo?: string;
      number?: number;
      revision?: number;
      state?: unknown;
    };
    const { fullName } = parseRepo(input.repo ?? null);
    const pullNumber = parsePullNumber(input.number);
    if (!Number.isSafeInteger(input.revision) || (input.revision ?? 0) <= 0) {
      throw new Error("A valid state revision is required.");
    }
    if (!isPullRequestState(input.state)) throw new Error("The PR state is malformed.");
    if (!validHeadSha(input.state.headSha)) throw new Error("A valid pull request head SHA is required.");
    if (new TextEncoder().encode(JSON.stringify(input.state)).byteLength > MAX_STATE_BYTES) {
      throw new Error("The PR state is too large to save.");
    }
    await savePullRequestState(
      viewer,
      fullName.toLowerCase(),
      pullNumber,
      input.state,
      input.revision!,
    );
    return Response.json({ saved: true });
  } catch (error) {
    return stateError(error);
  }
}

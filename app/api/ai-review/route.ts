import { NextRequest } from "next/server";
import { buildAiReview } from "@/lib/ai-review";
import { defaultReviewerModel, defaultScoutModel } from "@/lib/config";
import { githubFetch, githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import { readSession } from "@/lib/session";
import type { PullRequestDetail } from "@/lib/types";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const session = await readSession(request);
    if (!session.openrouter?.apiKey) throw new Error("OpenRouter authentication is required.");
    const token = await githubToken(request);
    const input = (await request.json()) as {
      repo?: string;
      number?: number;
      headSha?: string;
      scoutModel?: string;
      reviewerModel?: string;
    };
    const { fullName } = parseRepo(input.repo ?? null);
    const number = parsePullNumber(input.number);
    const scoutModel = input.scoutModel?.trim() || defaultScoutModel();
    const reviewerModel = input.reviewerModel?.trim() || defaultReviewerModel();
    const [pull, diffResponse] = await Promise.all([
      githubJson<{
        number: number;
        title: string;
        body: string | null;
        user: { login: string; avatar_url: string };
        base: { ref: string };
        head: { ref: string; sha: string };
      }>(token, `/repos/${fullName}/pulls/${number}`),
      githubFetch(token, `/repos/${fullName}/pulls/${number}`, {
        headers: { Accept: "application/vnd.github.v3.diff" },
      }),
    ]);
    if (input.headSha && pull.head.sha !== input.headSha) {
      throw new Error("This pull request changed before the AI review started. Refresh it and try again.");
    }
    const detail = {
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      author: { login: pull.user.login, avatarUrl: pull.user.avatar_url },
      base: pull.base.ref,
      head: pull.head.ref,
      diff: await diffResponse.text(),
    } as Pick<PullRequestDetail, "number" | "title" | "body" | "author" | "base" | "head" | "diff">;
    const review = await buildAiReview({
      repo: fullName,
      detail,
      apiKey: session.openrouter.apiKey,
      scoutModel,
      reviewerModel,
    });
    return Response.json({ review });
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from "next/server";
import { githubGraphql, githubJson, githubToken, jsonError, parseRepo } from "@/lib/github";
import { PULL_SIZES_QUERY, applyPullSizes, pullSizeMap } from "@/lib/pull-sizes";
import type { PullRequestSummary } from "@/lib/types";

const PAGE_SIZE = 100;

interface GitHubPull {
  number: number;
  title: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  user: { login: string; avatar_url: string };
  assignees: Array<{ login: string; avatar_url: string }>;
  requested_reviewers: Array<{ login: string; avatar_url: string }>;
  head: { ref: string };
  base: { ref: string };
}

export async function GET(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const { owner, repo, fullName } = parseRepo(request.nextUrl.searchParams.get("repo"));
    // Sizes are optional: a GraphQL failure leaves the rows without a size cluster.
    const [pulls, sizePayload] = await Promise.all([
      githubJson<GitHubPull[]>(token, `/repos/${fullName}/pulls?state=open&per_page=${PAGE_SIZE}&sort=updated&direction=desc`),
      githubGraphql<unknown>(token, PULL_SIZES_QUERY, { owner, repo, first: PAGE_SIZE }).catch(() => null),
    ]);
    const summaries: PullRequestSummary[] = pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      author: { login: pull.user.login, avatarUrl: pull.user.avatar_url },
      assignees: pull.assignees.map((person) => ({ login: person.login, avatarUrl: person.avatar_url })),
      requestedReviewers: pull.requested_reviewers.map((person) => ({ login: person.login, avatarUrl: person.avatar_url })),
      draft: pull.draft,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      head: pull.head.ref,
      base: pull.base.ref,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    }));
    return Response.json({ pulls: applyPullSizes(summaries, pullSizeMap(sizePayload)) });
  } catch (error) {
    return jsonError(error);
  }
}

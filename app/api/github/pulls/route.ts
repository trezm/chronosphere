import { NextRequest } from "next/server";
import { githubJson, githubToken, jsonError, parseRepo } from "@/lib/github";
import type { PullRequestSummary } from "@/lib/types";

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
    const { fullName } = parseRepo(request.nextUrl.searchParams.get("repo"));
    const pulls = await githubJson<GitHubPull[]>(token, `/repos/${fullName}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
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
    return Response.json({ pulls: summaries });
  } catch (error) {
    return jsonError(error);
  }
}

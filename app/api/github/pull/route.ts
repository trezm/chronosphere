import { NextRequest } from "next/server";
import { githubFetch, githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import type { PullRequestDetail } from "@/lib/types";

interface GitHubPullDetail {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  user: { login: string; avatar_url: string };
  assignees: Array<{ login: string; avatar_url: string }>;
  requested_reviewers: Array<{ login: string; avatar_url: string }>;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string } | null };
}

interface RepoSettings {
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const { fullName } = parseRepo(request.nextUrl.searchParams.get("repo"));
    const number = parsePullNumber(request.nextUrl.searchParams.get("number"));
    const [pull, settings, diffResponse] = await Promise.all([
      githubJson<GitHubPullDetail>(token, `/repos/${fullName}/pulls/${number}`),
      githubJson<RepoSettings>(token, `/repos/${fullName}`).catch((): RepoSettings => ({})),
      githubFetch(token, `/repos/${fullName}/pulls/${number}`, {
        headers: { Accept: "application/vnd.github.v3.diff" },
      }),
    ]);
    const allowedMergeMethods: PullRequestDetail["allowedMergeMethods"] = [];
    if (settings.allow_merge_commit !== false) allowedMergeMethods.push("merge");
    if (settings.allow_squash_merge !== false) allowedMergeMethods.push("squash");
    if (settings.allow_rebase_merge !== false) allowedMergeMethods.push("rebase");
    const detail: PullRequestDetail = {
      number: pull.number,
      title: pull.title,
      body: pull.body ?? "",
      url: pull.html_url,
      state: pull.state,
      merged: pull.merged,
      mergeable: pull.mergeable,
      mergeableState: pull.mergeable_state,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      baseRepo: pull.base.repo?.full_name ?? fullName,
      headRepo: pull.head.repo?.full_name ?? fullName,
      commits: pull.commits,
      author: { login: pull.user.login, avatarUrl: pull.user.avatar_url },
      assignees: pull.assignees.map((person) => ({ login: person.login, avatarUrl: person.avatar_url })),
      requestedReviewers: pull.requested_reviewers.map((person) => ({ login: person.login, avatarUrl: person.avatar_url })),
      draft: pull.draft,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      head: pull.head.ref,
      base: pull.base.ref,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      allowedMergeMethods,
      diff: await diffResponse.text(),
    };
    return Response.json({ pull: detail });
  } catch (error) {
    return jsonError(error);
  }
}

import { loadCommentRecording, replayFromComments, type PullComment } from "@/lib/comment-recording";
import { loadGistRecording, replayGistFromBody } from "@/lib/gist-recording";
import { NextRequest } from "next/server";
import { GitHubError, githubFetch, githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import { PR_RECORDING_PATH, readRecordingResponse } from "@/lib/pr-recording";

export async function GET(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const { fullName } = parseRepo(request.nextUrl.searchParams.get("repo"));
    const number = parsePullNumber(request.nextUrl.searchParams.get("number"));
    const headSha = request.nextUrl.searchParams.get("headSha");
    if (!headSha || !/^[a-f0-9]{40}$/i.test(headSha)) throw new Error("A valid PR head SHA is required.");
    const pull = await githubJson<{ body: string | null; user: { login: string } | null; head: { sha: string; repo: { full_name: string } | null } }>(token, `/repos/${fullName}/pulls/${number}`);
    if (pull.head.sha !== headSha) return Response.json({ error: "This PR changed. Reopen it before loading its recording." }, { status: 409 });
    const comments: PullComment[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await githubJson<PullComment[]>(token, `/repos/${fullName}/issues/${number}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    const comment = replayFromComments(comments, pull.user?.login);
    if (comment) return Response.json({ source: await loadCommentRecording(comment, token), path: "PR comment replay", origin: "comment", url: comment.url, headSha }, { headers: { "Cache-Control": "no-store" } });
    // Earlier replays were linked as secret gists from the PR description.
    const gist = replayGistFromBody(pull.body);
    if (gist) return Response.json({ source: await loadGistRecording(gist), path: "Gist replay", origin: "gist", url: gist.url, headSha }, { headers: { "Cache-Control": "no-store" } });
    if (!pull.head.repo) throw new Error("The PR's source repository is unavailable.");
    try {
      const response = await githubFetch(token, `/repos/${pull.head.repo.full_name}/contents/${PR_RECORDING_PATH}?ref=${headSha}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      return Response.json({ source: await readRecordingResponse(response), path: PR_RECORDING_PATH, origin: "repository", headSha }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return Response.json({ source: null, path: PR_RECORDING_PATH, origin: "repository", headSha }, { headers: { "Cache-Control": "no-store" } });
      throw error;
    }
  } catch (error) { return jsonError(error); }
}

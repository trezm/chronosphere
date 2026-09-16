import { NextRequest } from "next/server";
import { githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";

export async function POST(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const body = (await request.json()) as {
      repo?: string;
      number?: number;
      event?: string;
      body?: string;
      commitId?: string;
      comments?: Array<{ path?: string; line?: number; side?: string; body?: string }>;
    };
    const { fullName } = parseRepo(body.repo ?? null);
    const number = parsePullNumber(body.number);
    if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(body.event ?? '')) throw new Error("Choose a valid review action.");
    if (!body.commitId || !/^[a-f0-9]{40}$/i.test(body.commitId)) throw new Error("A valid reviewed commit SHA is required.");
    const pull = await githubJson<{ head: { sha: string } }>(token, `/repos/${fullName}/pulls/${number}`);
    if (pull.head.sha !== body.commitId) return Response.json({ error: "This PR changed since you opened it. Reopen the PR before submitting your review." }, { status: 409 });
    const comments = (body.comments ?? []).map((comment) => {
      if (!comment.path || !Number.isInteger(comment.line) || !['LEFT', 'RIGHT'].includes(comment.side ?? '') || !comment.body?.trim()) {
        throw new Error("Every pending comment needs a valid diff line and message.");
      }
      return { path: comment.path, line: comment.line, side: comment.side, body: comment.body.trim() };
    });
    if (!comments.length && !body.body?.trim()) throw new Error("Add a summary or at least one pending comment.");
    const review = await githubJson<{ id: number; html_url: string }>(token, `/repos/${fullName}/pulls/${number}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: body.body?.trim() ?? "",
        event: body.event,
        commit_id: body.commitId,
        comments,
      }),
    });
    return Response.json({ review: { id: review.id, url: review.html_url } });
  } catch (error) {
    return jsonError(error);
  }
}

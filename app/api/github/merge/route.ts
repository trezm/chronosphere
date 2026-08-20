import { NextRequest } from "next/server";
import { githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";

export async function POST(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const body = (await request.json()) as { repo?: string; number?: number; method?: string; sha?: string };
    const { fullName } = parseRepo(body.repo ?? null);
    const number = parsePullNumber(body.number);
    if (!['merge', 'squash', 'rebase'].includes(body.method ?? '')) throw new Error("Choose a valid merge method.");
    const result = await githubJson<{ merged: boolean; message: string; sha: string }>(token, `/repos/${fullName}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: body.method, sha: body.sha }),
    });
    if (!result.merged) throw new Error(result.message || "GitHub did not merge the pull request.");
    return Response.json({ merge: result });
  } catch (error) {
    return jsonError(error);
  }
}

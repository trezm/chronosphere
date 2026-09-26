import { COMPRESSED_RECORDING_FILE, COMPRESSED_RECORDING_MAX_BYTES, decompressRecording } from "./recording-transport.ts";
import { readRecordingResponse } from "./pr-recording.ts";

export type ReplayComment = { id: number; url: string; attachment: string };
export type PullComment = {
  id: number;
  html_url: string;
  body?: string | null;
  created_at: string;
  user: { login: string } | null;
  author_association?: string;
};

// Comments are open to anyone who can read the PR, so only people who could
// have produced the change may attach its replay.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ATTACHMENT = /^https:\/\/github\.com\/user-attachments\/files\/(\d{1,20})\/replay\.json$/;

/** Tags outside Markdown code fences, in document order. */
export function replayTags(body: string | null | undefined): string[] {
  const tags: string[] = [];
  let fence: string | null = null;
  for (const line of (body ?? "").split(/\r?\n/)) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (!fence && line.startsWith("chronosphere-replay:")) tags.push(line.slice("chronosphere-replay:".length).trim());
  }
  return tags;
}

/** The newest trusted comment with a replay tag wins, so re-sharing is just another comment. */
export function replayFromComments(comments: PullComment[], pullAuthor: string | null | undefined): ReplayComment | null {
  const trusted = comments
    .filter((comment) => (comment.user && comment.user.login === pullAuthor) || TRUSTED_ASSOCIATIONS.has(comment.author_association ?? ""))
    .map((comment) => ({ comment, tags: replayTags(comment.body) }))
    .filter(({ tags }) => tags.length)
    .sort((a, b) => Date.parse(b.comment.created_at) - Date.parse(a.comment.created_at) || b.comment.id - a.comment.id);
  if (!trusted.length) return null;
  const { comment, tags } = trusted[0];
  if (tags.length !== 1) throw new Error("Keep exactly one chronosphere-replay tag in the replay comment.");
  // Match the original spelling: URL normalization must not hide traversal or credentials.
  if (!ATTACHMENT.test(tags[0])) {
    throw new Error(`The replay comment's chronosphere-replay tag must be a GitHub attachment URL ending in /${COMPRESSED_RECORDING_FILE}.`);
  }
  return { id: comment.id, url: comment.html_url, attachment: tags[0] };
}

/**
 * GitHub answers attachment URLs with a redirect to short-lived signed storage.
 * The token only goes to github.com; the signed download is fetched without it.
 */
export async function loadCommentRecording(replay: ReplayComment, token: string, request: typeof fetch = fetch): Promise<string> {
  const options: RequestInit = { cache: "no-store", signal: AbortSignal.timeout(15_000) };
  const unavailable = "GitHub did not serve the replay attachment. Attachments on private repositories may only open in a signed-in browser; commit the replay or attach it manually instead.";
  const first = await request(replay.attachment, {
    ...options, redirect: "manual", headers: { Authorization: `Bearer ${token}`, "User-Agent": "chronosphere" },
  });
  let response = first;
  if (first.status >= 300 && first.status < 400) {
    await first.body?.cancel();
    let target: URL;
    try { target = new URL(first.headers.get("location") ?? "", replay.attachment); } catch { throw new Error(unavailable); }
    // A redirect back to github.com is a sign-in page, not the file.
    if (target.protocol !== "https:" || target.username || target.password || target.hostname === "github.com" || target.hostname.endsWith(".github.com")) {
      throw new Error(unavailable);
    }
    response = await request(target.href, { ...options, redirect: "error", headers: { "User-Agent": "chronosphere" } });
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(unavailable); }
  const source = await readRecordingResponse(response, COMPRESSED_RECORDING_MAX_BYTES);
  return decompressRecording(source, true);
}

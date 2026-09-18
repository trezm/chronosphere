import { readRecordingResponse } from "./pr-recording.ts";

export const GIST_RECORDING_FILE = "replay.jsonl";
export const GIST_RECORDING_MAX_BYTES = 10 * 1024 * 1024;
export type ReplayGist = { id: string; revision?: string; url: string };

/** Only standalone tags outside Markdown code fences count as attachments. */
export function replayGistFromBody(body: string | null | undefined): ReplayGist | null {
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
  if (!tags.length) return null;
  if (tags.length !== 1) throw new Error("Keep exactly one chronosphere-replay tag in the PR description.");
  // Parse the original spelling: URL normalization must not hide traversal or credentials.
  // GitHub also returns ownerless URLs; recognize their pinned form before
  // interpreting the first component as an owner.
  const match = tags[0].match(/^https:\/\/gist\.github\.com\/([a-fA-F0-9]{5,64})\/([a-fA-F0-9]{40})\/?$/)
    ?? tags[0].match(/^https:\/\/gist\.github\.com\/(?:[a-zA-Z0-9-]+\/)?([a-fA-F0-9]{5,64})(?:\/([a-fA-F0-9]{40}))?\/?$/);
  if (!match) throw new Error("The chronosphere-replay tag must contain a GitHub gist URL, optionally pinned to a revision.");
  return { id: match[1].toLowerCase(), ...(match[2] ? { revision: match[2].toLowerCase() } : {}), url: tags[0] };
}

/** Gists are link-accessible. Never send the user's repository token to these downloads. */
export async function loadGistRecording(gist: ReplayGist, request: typeof fetch = fetch): Promise<string> {
  const options: RequestInit = { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) };
  const metadata = await request(`https://api.github.com/gists/${gist.id}${gist.revision ? `/${gist.revision}` : ""}`, {
    ...options, headers: { Accept: "application/vnd.github+json", "User-Agent": "chronosphere", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!metadata.ok) throw new Error(`Could not load the replay gist (GitHub ${metadata.status}). Check its URL and availability.`);
  const data = JSON.parse(await readRecordingResponse(metadata, 2 * 1024 * 1024)) as {
    files?: Record<string, { size?: number; raw_url?: string }>;
  };
  const file = data?.files?.[GIST_RECORDING_FILE];
  if (!file) throw new Error(`The replay gist must contain a file named ${GIST_RECORDING_FILE}.`);
  if (!Number.isSafeInteger(file.size) || file.size! < 0 || file.size! > GIST_RECORDING_MAX_BYTES) {
    throw new Error("Gist recordings must be 10 MB or smaller. Use a committed replay or manual attachment for larger recordings.");
  }
  const raw = file.raw_url?.match(/^https:\/\/gist\.githubusercontent\.com\/[a-zA-Z0-9-]+\/([a-fA-F0-9]{5,64})\/raw\/([a-fA-F0-9]{40})\/replay\.jsonl$/);
  if (!raw || raw[1].toLowerCase() !== gist.id || (gist.revision && raw[2].toLowerCase() !== gist.revision)) {
    throw new Error("GitHub returned an unexpected replay download URL.");
  }
  // Always fetch raw content: Gist API content is truncated above 1 MB.
  const response = await request(file.raw_url!, options);
  if (!response.ok) throw new Error(`Could not download the replay gist (GitHub ${response.status}).`);
  const source = await readRecordingResponse(response, GIST_RECORDING_MAX_BYTES);
  if (new TextEncoder().encode(source).length !== file.size) throw new Error("The replay gist download is incomplete. Try again or attach the original recording.");
  return source;
}

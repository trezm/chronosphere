import { parseUnifiedDiff } from "./diff.ts";
import { isReplay } from "./review-cache.ts";
import type { DiffFile, PullRequestDetail, ReplayChunk, ReplayResult } from "./types";

/**
 * Where the review command on this computer listens. The link it prints
 * carries both in the fragment, which browsers never send to the server.
 */
export interface LocalBridge {
  origin: string;
  token: string;
}

/** The snapshot `scripts/review.mjs` serves: a working copy against its merge base. */
export interface LocalReviewSession {
  format: "chronosphere.local-review";
  version: 1;
  id: string;
  createdAt: string;
  repository: { name: string; branch: string | null };
  title: string;
  body: string;
  /** The merge base the diff starts from, and the ref it was found with. */
  base: { ref: string; sha: string };
  /** `sha` is the snapshot's tree object, which pins uncommitted content too. */
  head: { sha: string; commit: string; uncommitted: boolean };
  commits: Array<{ sha: string; subject: string }>;
  diff: string;
  recording: { id: string; name: string; source: string } | null;
  /** The agent's own reconstruction from `--plan`; absent from commands before it existed. */
  replay?: ReplayResult | null;
}

export function parseLocalBridge(fragment: string): LocalBridge | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const port = Number(params.get("port"));
  const token = params.get("token") ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
  // Only loopback is ever contacted, whatever a link says.
  return { origin: `http://127.0.0.1:${port}`, token };
}

/** The fragment form of a bridge, for restoring it after the address bar is cleaned. */
export function localBridgeFragment(bridge: LocalBridge): string {
  return new URLSearchParams({ port: new URL(bridge.origin).port, token: bridge.token }).toString();
}

const SHA = /^[0-9a-f]{40}$/;

export function isLocalReviewSession(value: unknown): value is LocalReviewSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<LocalReviewSession>;
  return session.format === "chronosphere.local-review"
    && session.version === 1
    && typeof session.id === "string"
    && typeof session.title === "string"
    && typeof session.body === "string"
    && typeof session.diff === "string"
    && typeof session.repository?.name === "string"
    && (session.repository.branch === null || typeof session.repository.branch === "string")
    && typeof session.base?.ref === "string" && SHA.test(session.base.sha ?? "")
    && SHA.test(session.head?.sha ?? "") && SHA.test(session.head?.commit ?? "") && typeof session.head?.uncommitted === "boolean"
    && Array.isArray(session.commits)
    && (session.recording === null || (typeof session.recording?.id === "string" && typeof session.recording.name === "string" && typeof session.recording.source === "string"))
    && (session.replay === undefined || session.replay === null || (isReplay(session.replay) && session.replay.source === undefined));
}

/** Calls the review command. A refused connection usually means it already finished or was stopped. */
export async function bridgeRequest<T>(bridge: LocalBridge, path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, bridge.origin);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${bridge.token}`);
  const request: RequestInit = { ...init, headers, cache: "no-store" };
  let response: Response;
  try {
    // Chrome's Local Network Access guide asks callers to name the address
    // space; Safari 26.2 rejects the option outright, so retry without it.
    response = await fetch(url, { ...request, targetAddressSpace: "loopback" } as RequestInit).catch(() => fetch(url, request));
  } catch {
    throw new Error("Could not reach the review command on this computer. It may have finished or been stopped. If the browser asked to allow access to apps on this device, allow it and try again. Safari blocks websites from reaching this computer; use Chrome or Firefox.");
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || `${response.status} ${response.statusText}`);
  return body;
}

/** The pull request shape the review workspace renders, filled from a local snapshot. */
export function localPullDetail(session: LocalReviewSession, files: DiffFile[] = parseUnifiedDiff(session.diff)): PullRequestDetail {
  const changed = files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)).filter((line) => line.changedIndex !== null);
  return {
    number: 0,
    title: session.title,
    body: session.body,
    url: "",
    state: "open",
    merged: false,
    mergeable: null,
    mergeableState: "local",
    baseSha: session.base.sha,
    headSha: session.head.sha,
    baseRepo: session.repository.name,
    headRepo: session.repository.name,
    commits: session.commits.length,
    author: { login: "local", avatarUrl: "" },
    assignees: [],
    requestedReviewers: [],
    draft: false,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
    head: session.repository.branch ?? session.head.commit.slice(0, 8),
    base: session.base.ref,
    additions: changed.filter((line) => line.type === "add").length,
    deletions: changed.filter((line) => line.type === "delete").length,
    changedFiles: files.length,
    allowedMergeMethods: [],
    diff: session.diff,
  };
}

const VERBS: Record<DiffFile["status"], string> = { added: "Add", deleted: "Delete", modified: "Update", renamed: "Rename" };

/** Without a recording, local changes play one file at a time, in diff order. */
export function fileReplay(files: DiffFile[]): ReplayResult {
  const chunks = files.flatMap((file): ReplayChunk[] => {
    const changed = file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.changedIndex !== null);
    if (!changed.length) return [];
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const added = changed.filter((line) => line.type === "add").length;
    return [{
      // Changed lines are numbered across the whole diff, so one file's lines are one contiguous range.
      ranges: [{ file: file.path, start: changed[0].changedIndex!, end: changed.at(-1)!.changedIndex! }],
      title: `${VERBS[file.status]} ${name}`,
      description: `${file.status === "renamed" && file.oldPath ? `${file.oldPath} → ` : ""}${file.path}: +${added} −${changed.length - added}`,
    }];
  });
  return { model: "Changed files", chunks, truncated: false };
}

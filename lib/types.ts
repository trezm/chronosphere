export interface SessionUser {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface Repository {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  ownerAvatarUrl: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author: { login: string; avatarUrl: string };
  assignees: { login: string; avatarUrl: string }[];
  requestedReviewers: { login: string; avatarUrl: string }[];
  draft: boolean;
  updatedAt: string;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  baseSha: string;
  headSha: string;
  baseRepo: string;
  headRepo: string;
  commits: number;
  allowedMergeMethods: Array<"merge" | "squash" | "rebase">;
  diff: string;
}

export type DiffLineType = "context" | "add" | "delete";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  changedIndex: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  hunks: DiffHunk[];
}

export interface ReplayChunk {
  file: string;
  start: number;
  end: number;
  title: string;
  description: string;
}

export interface ReplayResult {
  model: string;
  chunks: ReplayChunk[];
  truncated: boolean;
}

export interface PendingComment {
  id: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  step: number;
}

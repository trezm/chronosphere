import type { Repository } from "./types";

/** Per-browser record of when each repository was last opened in the picker. */
export type RepoRecency = Record<string, number>;

export const REPO_RECENCY_KEY = "chronosphere:repo-recency";
const RECENCY_LIMIT = 50;

export function loadRepoRecency(storage: Storage | null): RepoRecency {
  if (!storage) return {};
  try {
    const raw = storage.getItem(REPO_RECENCY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const recency: RepoRecency = {};
    for (const [fullName, openedAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof openedAt === "number" && Number.isFinite(openedAt)) recency[fullName] = openedAt;
    }
    return recency;
  } catch {
    // Storage may be unavailable or hold unparsable data.
    return {};
  }
}

/** Records an open and prunes the oldest entries past the cap. */
export function recordRepoOpened(storage: Storage | null, fullName: string, openedAt = Date.now()): RepoRecency {
  const merged = { ...loadRepoRecency(storage), [fullName]: openedAt };
  const kept = Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, RECENCY_LIMIT);
  const recency: RepoRecency = Object.fromEntries(kept);
  try {
    storage?.setItem(REPO_RECENCY_KEY, JSON.stringify(recency));
  } catch {
    // Storage may be unavailable; recency is a convenience, not a requirement.
  }
  return recency;
}

/** Most recently opened first, then everything else in the order the API returned. */
export function orderByRecency(repositories: Repository[], recency: RepoRecency): Repository[] {
  const recent = repositories.filter((repo) => recency[repo.fullName] !== undefined);
  if (recent.length === 0) return repositories;
  recent.sort((a, b) => recency[b.fullName] - recency[a.fullName]);
  return [...recent, ...repositories.filter((repo) => recency[repo.fullName] === undefined)];
}

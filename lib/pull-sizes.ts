import type { PullRequestSummary } from "./types";

/**
 * The REST pulls list omits size fields, so they come from one GraphQL call
 * that mirrors the REST page size and ordering and is joined on pull number.
 */
export interface PullSize {
  additions: number;
  deletions: number;
  changedFiles: number;
}

export const PULL_SIZES_QUERY = `query PullSizes($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number additions deletions changedFiles }
    }
  }
}`;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Tolerant read of the GraphQL payload; anything unexpected simply yields no size. */
export function pullSizeMap(payload: unknown): Map<number, PullSize> {
  const sizes = new Map<number, PullSize>();
  const nodes = (payload as { repository?: { pullRequests?: { nodes?: unknown } } } | null | undefined)
    ?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) return sizes;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const { number: pullNumber, additions, deletions, changedFiles } = node as Record<string, unknown>;
    if (!isCount(pullNumber) || !isCount(additions) || !isCount(deletions) || !isCount(changedFiles)) continue;
    sizes.set(pullNumber, { additions, deletions, changedFiles });
  }
  return sizes;
}

/** Summaries keep their REST values wherever a size is missing. */
export function applyPullSizes(summaries: PullRequestSummary[], sizes: Map<number, PullSize>): PullRequestSummary[] {
  if (sizes.size === 0) return summaries;
  return summaries.map((summary) => {
    const size = sizes.get(summary.number);
    return size ? { ...summary, ...size } : summary;
  });
}

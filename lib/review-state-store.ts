import { and, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { pullRequestStates } from "@/db/schema";
import type { PullRequestState } from "./review-state";

export interface StoredPullRequestState {
  state: PullRequestState;
  revision: number;
}

export async function loadPullRequestState(
  viewer: string,
  repository: string,
  pullNumber: number,
  headSha: string,
): Promise<StoredPullRequestState | null> {
  const db = await getDb();
  const [row] = await db.select({
    headSha: pullRequestStates.headSha,
    revision: pullRequestStates.revision,
    state: pullRequestStates.state,
  }).from(pullRequestStates).where(and(
    eq(pullRequestStates.viewer, viewer),
    eq(pullRequestStates.repository, repository),
    eq(pullRequestStates.pullNumber, pullNumber),
    eq(pullRequestStates.headSha, headSha),
  )).limit(1);

  if (!row) return null;

  try {
    return { state: JSON.parse(row.state) as PullRequestState, revision: row.revision };
  } catch {
    await deletePullRequestState(viewer, repository, pullNumber, headSha);
    return null;
  }
}

export async function savePullRequestState(
  viewer: string,
  repository: string,
  pullNumber: number,
  state: PullRequestState,
  revision: number,
): Promise<void> {
  const db = await getDb();
  await db.insert(pullRequestStates).values({
    viewer,
    repository,
    pullNumber,
    headSha: state.headSha,
    revision,
    state: JSON.stringify(state),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [pullRequestStates.viewer, pullRequestStates.repository, pullRequestStates.pullNumber, pullRequestStates.headSha],
    set: {
      headSha: state.headSha,
      revision,
      state: JSON.stringify(state),
      updatedAt: new Date(),
    },
    setWhere: lt(pullRequestStates.revision, revision),
  });
}

export async function deletePullRequestState(
  viewer: string,
  repository: string,
  pullNumber: number,
  headSha: string,
): Promise<void> {
  const db = await getDb();
  await db.delete(pullRequestStates).where(and(
    eq(pullRequestStates.viewer, viewer),
    eq(pullRequestStates.repository, repository),
    eq(pullRequestStates.pullNumber, pullNumber),
    eq(pullRequestStates.headSha, headSha),
  ));
}

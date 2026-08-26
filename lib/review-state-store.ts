import { and, eq, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { pullRequestStates } from "@/db/schema";
import type { InProgressReview } from "./review-cache";

export interface StoredPullRequestState {
  state: InProgressReview;
  revision: number;
}

export async function loadPullRequestState(
  viewer: string,
  repository: string,
  pullNumber: number,
  headSha: string,
): Promise<StoredPullRequestState | null> {
  const db = getDb();
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

  await db.delete(pullRequestStates).where(and(
    eq(pullRequestStates.viewer, viewer),
    eq(pullRequestStates.repository, repository),
    eq(pullRequestStates.pullNumber, pullNumber),
    ne(pullRequestStates.headSha, headSha),
  ));
  if (!row) return null;

  try {
    return { state: JSON.parse(row.state) as InProgressReview, revision: row.revision };
  } catch {
    await deletePullRequestState(viewer, repository, pullNumber);
    return null;
  }
}

export async function savePullRequestState(
  viewer: string,
  repository: string,
  pullNumber: number,
  state: InProgressReview,
  revision: number,
): Promise<void> {
  await getDb().insert(pullRequestStates).values({
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
): Promise<void> {
  await getDb().delete(pullRequestStates).where(and(
    eq(pullRequestStates.viewer, viewer),
    eq(pullRequestStates.repository, repository),
    eq(pullRequestStates.pullNumber, pullNumber),
  ));
}

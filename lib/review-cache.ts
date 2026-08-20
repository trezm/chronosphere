import type { PendingComment, ReplayResult } from "./types";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface InProgressReview {
  headSha: string;
  replay: ReplayResult;
  step: number;
  comments: PendingComment[];
  summary: string;
  event: ReviewEvent;
  model: string;
  showFullDiff: boolean;
}

type StoredReview = InProgressReview & {
  version: 1;
  updatedAt: number;
};

const CACHE_PREFIX = "chronosphere-review:v1";

export function reviewCacheKey(viewer: string, repo: string, pullNumber: number): string {
  return `${CACHE_PREFIX}:${encodeURIComponent(viewer.toLowerCase())}:${encodeURIComponent(repo.toLowerCase())}:${pullNumber}`;
}

function isReviewEvent(value: unknown): value is ReviewEvent {
  return value === "COMMENT" || value === "APPROVE" || value === "REQUEST_CHANGES";
}

function isReplay(value: unknown): value is ReplayResult {
  if (!value || typeof value !== "object") return false;
  const replay = value as Partial<ReplayResult>;
  return typeof replay.model === "string"
    && typeof replay.truncated === "boolean"
    && Array.isArray(replay.chunks)
    && replay.chunks.length > 0
    && replay.chunks.every((chunk) => !!chunk
      && typeof chunk.file === "string"
      && typeof chunk.start === "number"
      && typeof chunk.end === "number"
      && typeof chunk.title === "string"
      && typeof chunk.description === "string");
}

function isPendingComment(value: unknown): value is PendingComment {
  if (!value || typeof value !== "object") return false;
  const comment = value as Partial<PendingComment>;
  return typeof comment.id === "string"
    && typeof comment.path === "string"
    && typeof comment.line === "number"
    && (comment.side === "LEFT" || comment.side === "RIGHT")
    && typeof comment.body === "string"
    && typeof comment.step === "number";
}

function isStoredReview(value: unknown): value is StoredReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<StoredReview>;
  return review.version === 1
    && typeof review.updatedAt === "number"
    && typeof review.headSha === "string"
    && isReplay(review.replay)
    && typeof review.step === "number"
    && Number.isInteger(review.step)
    && review.step >= 0
    && Array.isArray(review.comments)
    && review.comments.every(isPendingComment)
    && typeof review.summary === "string"
    && isReviewEvent(review.event)
    && typeof review.model === "string"
    && typeof review.showFullDiff === "boolean";
}

export function loadInProgressReview(storage: Storage, key: string, headSha: string): InProgressReview | null {
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const stored: unknown = JSON.parse(raw);
    if (!isStoredReview(stored) || stored.headSha !== headSha) {
      storage.removeItem(key);
      return null;
    }
    return {
      headSha: stored.headSha,
      replay: stored.replay,
      step: stored.step,
      comments: stored.comments,
      summary: stored.summary,
      event: stored.event,
      model: stored.model,
      showFullDiff: stored.showFullDiff,
    };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function saveInProgressReview(storage: Storage, key: string, review: InProgressReview): void {
  const stored: StoredReview = { version: 1, updatedAt: Date.now(), ...review };
  storage.setItem(key, JSON.stringify(stored));
}

export function clearInProgressReview(storage: Storage, key: string): void {
  storage.removeItem(key);
}

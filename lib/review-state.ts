import type { AiReviewResult, PendingComment, ReplayResult } from "./types";
import {
  isAiReview,
  isPendingComment,
  isReplay,
  isReviewEvent,
  type InProgressReview,
  type ReviewEvent,
} from "./review-cache.ts";

export interface ReviewDraft {
  comments: PendingComment[];
  summary: string;
  event: ReviewEvent;
}

export interface PullRequestState {
  headSha: string;
  replay: ReplayResult;
  step: number;
  model: string;
  showFullDiff: boolean;
  aiReview?: AiReviewResult;
  scoutModel?: string;
  reviewerModel?: string;
  review?: ReviewDraft;
  /** Tree replays: the steps the reviewer has marked as viewed. */
  viewed?: number[];
}

function isReviewDraft(value: unknown): value is ReviewDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<ReviewDraft>;
  return Array.isArray(draft.comments)
    && draft.comments.every(isPendingComment)
    && typeof draft.summary === "string"
    && isReviewEvent(draft.event)
    && (draft.comments.length > 0 || draft.summary.trim().length > 0);
}

export function isPullRequestState(value: unknown): value is PullRequestState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PullRequestState>;
  return typeof state.headSha === "string"
    && isReplay(state.replay)
    && typeof state.step === "number"
    && Number.isInteger(state.step)
    && state.step >= 0
    && typeof state.model === "string"
    && typeof state.showFullDiff === "boolean"
    && (state.aiReview === undefined || isAiReview(state.aiReview))
    && (state.scoutModel === undefined || typeof state.scoutModel === "string")
    && (state.reviewerModel === undefined || typeof state.reviewerModel === "string")
    && (state.review === undefined || isReviewDraft(state.review))
    && (state.viewed === undefined || (Array.isArray(state.viewed) && state.viewed.every((index) => Number.isInteger(index) && index >= 0)));
}

export function migrateInProgressReview(review: InProgressReview): PullRequestState {
  const state: PullRequestState = {
    headSha: review.headSha,
    replay: review.replay,
    step: review.step,
    model: review.model,
    showFullDiff: review.showFullDiff,
    aiReview: review.aiReview,
    scoutModel: review.scoutModel,
    reviewerModel: review.reviewerModel,
  };
  if (review.comments.length || review.summary.trim()) {
    state.review = { comments: review.comments, summary: review.summary, event: review.event };
  }
  return state;
}

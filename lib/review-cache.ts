import type { AiReviewResult, PendingComment, ReplayChunk, ReplayRange, ReplayResult } from "./types";

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
  aiReview?: AiReviewResult;
  scoutModel?: string;
  reviewerModel?: string;
}

type StoredReview = InProgressReview & {
  version: 1;
  updatedAt: number;
};

const CACHE_PREFIX = "chronosphere-review:v1";

export function reviewCacheKey(viewer: string, repo: string, pullNumber: number): string {
  return `${CACHE_PREFIX}:${encodeURIComponent(viewer.toLowerCase())}:${encodeURIComponent(repo.toLowerCase())}:${pullNumber}`;
}

export function isReviewEvent(value: unknown): value is ReviewEvent {
  return value === "COMMENT" || value === "APPROVE" || value === "REQUEST_CHANGES";
}

function isReplayRange(value: unknown): value is ReplayRange {
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<ReplayRange>;
  return typeof range.file === "string"
    && Number.isInteger(range.start)
    && (range.start as number) >= 0
    && Number.isInteger(range.end)
    && (range.end as number) >= (range.start as number);
}

/** The single-range step shape stored before steps could span files. */
type LegacyReplayChunk = Omit<ReplayChunk, "ranges"> & ReplayRange;

function isReplayChunk(value: unknown): value is ReplayChunk | LegacyReplayChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Partial<ReplayChunk> & Partial<ReplayRange>;
  const coverage = Array.isArray(chunk.ranges)
    ? chunk.ranges.length > 0 && chunk.ranges.every(isReplayRange)
    : isReplayRange(chunk);
  return coverage
    && typeof chunk.title === "string"
    && typeof chunk.description === "string"
    && (chunk.impactful === undefined || typeof chunk.impactful === "boolean");
}

/** Accepts replays stored in either the current or the legacy single-range step shape. */
export function isReplay(value: unknown): value is ReplayResult {
  if (!value || typeof value !== "object") return false;
  const replay = value as Partial<ReplayResult>;
  return typeof replay.model === "string"
    && typeof replay.truncated === "boolean"
    && Array.isArray(replay.chunks)
    && replay.chunks.length > 0
    && replay.chunks.every(isReplayChunk);
}

/** Rewrites legacy single-range steps into the current multi-range shape. */
export function upgradeReplay(replay: ReplayResult): ReplayResult {
  const chunks = (replay.chunks as Array<ReplayChunk | LegacyReplayChunk>).map((chunk): ReplayChunk => {
    if ("ranges" in chunk && Array.isArray(chunk.ranges)) return chunk;
    const { file, start, end, ...rest } = chunk as LegacyReplayChunk;
    return { ...rest, ranges: [{ file, start, end }] };
  });
  return chunks.every((chunk, index) => chunk === replay.chunks[index]) ? replay : { ...replay, chunks };
}

export function isPendingComment(value: unknown): value is PendingComment {
  if (!value || typeof value !== "object") return false;
  const comment = value as Partial<PendingComment>;
  return typeof comment.id === "string"
    && typeof comment.path === "string"
    && typeof comment.line === "number"
    && Number.isInteger(comment.line)
    && comment.line > 0
    && (comment.side === "LEFT" || comment.side === "RIGHT")
    && typeof comment.body === "string"
    && typeof comment.step === "number"
    && Number.isInteger(comment.step)
    && comment.step >= 0;
}

export function isAiReview(value: unknown): value is AiReviewResult {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<AiReviewResult>;
  const severities = new Set(["critical", "high", "medium", "low"]);
  const categories = new Set(["bug", "security", "performance", "correctness", "design", "test"]);
  const risks = new Set(["high", "medium", "low"]);
  return typeof review.scoutModel === "string"
    && typeof review.reviewerModel === "string"
    && typeof review.summary === "string"
    && typeof review.truncated === "boolean"
    && !!review.scout
    && typeof review.scout.intent === "string"
    && Array.isArray(review.scout.focusAreas)
    && review.scout.focusAreas.every((area) => !!area
      && typeof area.file === "string"
      && typeof area.reason === "string"
      && risks.has(area.risk))
    && Array.isArray(review.findings)
    && review.findings.every((finding) => !!finding
      && typeof finding.file === "string"
      && typeof finding.line === "number"
      && Number.isInteger(finding.line)
      && finding.line > 0
      && severities.has(finding.severity)
      && categories.has(finding.category)
      && typeof finding.title === "string"
      && typeof finding.description === "string"
      && typeof finding.suggestion === "string");
}

export function isInProgressReview(value: unknown): value is InProgressReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<InProgressReview>;
  return typeof review.headSha === "string"
    && isReplay(review.replay)
    && typeof review.step === "number"
    && Number.isInteger(review.step)
    && review.step >= 0
    && Array.isArray(review.comments)
    && review.comments.every(isPendingComment)
    && typeof review.summary === "string"
    && isReviewEvent(review.event)
    && typeof review.model === "string"
    && typeof review.showFullDiff === "boolean"
    && (review.aiReview === undefined || isAiReview(review.aiReview))
    && (review.scoutModel === undefined || typeof review.scoutModel === "string")
    && (review.reviewerModel === undefined || typeof review.reviewerModel === "string");
}

function isStoredReview(value: unknown): value is StoredReview {
  if (!value || typeof value !== "object") return false;
  const review = value as Partial<StoredReview>;
  return review.version === 1
    && typeof review.updatedAt === "number"
    && isInProgressReview(review);
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
    const review: InProgressReview = {
      headSha: stored.headSha,
      replay: stored.replay,
      step: stored.step,
      comments: stored.comments,
      summary: stored.summary,
      event: stored.event,
      model: stored.model,
      showFullDiff: stored.showFullDiff,
    };
    if (stored.aiReview) review.aiReview = stored.aiReview;
    if (stored.scoutModel) review.scoutModel = stored.scoutModel;
    if (stored.reviewerModel) review.reviewerModel = stored.reviewerModel;
    return review;
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

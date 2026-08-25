import assert from "node:assert/strict";
import test from "node:test";
import {
  clearInProgressReview,
  loadInProgressReview,
  reviewCacheKey,
  saveInProgressReview,
} from "../lib/review-cache.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const review = {
  headSha: "abc123",
  replay: {
    model: "openai/gpt-5-mini",
    chunks: [{ file: "app.ts", start: 1, end: 2, title: "Add app", description: "Adds the app." }],
    truncated: false,
  },
  step: 0,
  comments: [{ id: "comment-1", path: "app.ts", line: 2, side: "RIGHT", body: "Please test this.", step: 0 }],
  summary: "One concern.",
  event: "REQUEST_CHANGES",
  model: "openai/gpt-5-mini",
  showFullDiff: false,
};

test("round-trips an in-progress review in browser storage", () => {
  const storage = memoryStorage();
  const key = reviewCacheKey("Pete", "Acme/Widget", 42);

  saveInProgressReview(storage, key, review);

  assert.deepEqual(loadInProgressReview(storage, key, review.headSha), review);
  clearInProgressReview(storage, key);
  assert.equal(storage.length, 0);
});

test("invalidates a cached review when the pull request head changes", () => {
  const storage = memoryStorage();
  const key = reviewCacheKey("Pete", "Acme/Widget", 42);
  saveInProgressReview(storage, key, review);

  assert.equal(loadInProgressReview(storage, key, "new-head"), null);
  assert.equal(storage.length, 0);
});

test("discards malformed cached reviews", () => {
  const storage = memoryStorage();
  const key = reviewCacheKey("Pete", "Acme/Widget", 42);
  storage.setItem(key, "not json");

  assert.equal(loadInProgressReview(storage, key, review.headSha), null);
  assert.equal(storage.length, 0);
});

test("restores an AI review with the draft it belongs to", () => {
  const storage = memoryStorage();
  const key = reviewCacheKey("Pete", "Acme/Widget", 42);
  const aiReview = {
    scoutModel: "openai/gpt-5-mini",
    reviewerModel: "anthropic/claude-sonnet-4",
    scout: { intent: "Check the parser.", focusAreas: [{ file: "app.ts", reason: "Input boundary", risk: "high" }] },
    summary: "One issue found.",
    findings: [{ file: "app.ts", line: 2, severity: "high", category: "correctness", title: "Unchecked input", description: "The input can be empty.", suggestion: "Validate it." }],
    truncated: false,
  };
  const withAiReview = { ...review, aiReview, scoutModel: aiReview.scoutModel, reviewerModel: aiReview.reviewerModel };

  saveInProgressReview(storage, key, withAiReview);

  assert.deepEqual(loadInProgressReview(storage, key, review.headSha), withAiReview);
});

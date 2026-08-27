import assert from "node:assert/strict";
import test from "node:test";
import { isPullRequestState, migrateInProgressReview } from "../lib/review-state.ts";

const legacy = {
  headSha: "0123456789012345678901234567890123456789",
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

test("migrates a legacy browser draft into the review portion of PR state", () => {
  const state = migrateInProgressReview(legacy);

  assert.deepEqual(state.review, {
    comments: legacy.comments,
    summary: legacy.summary,
    event: legacy.event,
  });
  assert.equal(isPullRequestState(state), true);
});

test("playback remains valid after a completed review without persisting an empty draft", () => {
  const state = migrateInProgressReview({ ...legacy, comments: [], summary: "", event: "COMMENT" });

  assert.equal("review" in state, false);
  assert.equal(isPullRequestState(state), true);
  assert.equal(isPullRequestState({
    ...state,
    review: { comments: [], summary: "", event: "COMMENT" },
  }), false);
});

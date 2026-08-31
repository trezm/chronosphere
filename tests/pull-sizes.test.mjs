import assert from "node:assert/strict";
import test from "node:test";
import { PULL_SIZES_QUERY, applyPullSizes, pullSizeMap } from "../lib/pull-sizes.ts";

const summary = {
  number: 7,
  title: "Tighten the parser",
  author: { login: "pete", avatarUrl: "https://example.test/pete.png" },
  assignees: [],
  requestedReviewers: [],
  draft: false,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
  head: "feature",
  base: "main",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
};

const summaries = [summary, { ...summary, number: 9, title: "Add a cache" }];

function payload(nodes) {
  return { repository: { pullRequests: { nodes } } };
}

test("joins GraphQL sizes onto the REST summaries by pull number", () => {
  const sizes = pullSizeMap(payload([
    { number: 9, additions: 12, deletions: 3, changedFiles: 2 },
    { number: 7, additions: 140, deletions: 26, changedFiles: 9 },
  ]));

  const joined = applyPullSizes(summaries, sizes);

  assert.deepEqual(joined[0], { ...summary, additions: 140, deletions: 26, changedFiles: 9 });
  assert.deepEqual(joined[1], { ...summary, number: 9, title: "Add a cache", additions: 12, deletions: 3, changedFiles: 2 });
});

test("leaves pull requests the size query did not cover untouched", () => {
  const joined = applyPullSizes(summaries, pullSizeMap(payload([{ number: 7, additions: 4, deletions: 1, changedFiles: 1 }])));

  assert.equal(joined[0].additions, 4);
  assert.deepEqual(joined[1], { ...summary, number: 9, title: "Add a cache" });
});

test("degrades to the REST summaries when the size payload is unusable", () => {
  for (const unusable of [null, undefined, {}, { repository: null }, payload(null), payload("nope")]) {
    assert.equal(pullSizeMap(unusable).size, 0);
    assert.deepEqual(applyPullSizes(summaries, pullSizeMap(unusable)), summaries);
  }
});

test("skips malformed size nodes rather than emitting junk counts", () => {
  const sizes = pullSizeMap(payload([
    null,
    "nope",
    { number: 7 },
    { number: 7.5, additions: 1, deletions: 1, changedFiles: 1 },
    { number: 11, additions: -4, deletions: 1, changedFiles: 1 },
    { number: 12, additions: "many", deletions: 1, changedFiles: 1 },
    { number: 13, additions: 5, deletions: 2, changedFiles: 1 },
  ]));

  assert.deepEqual([...sizes.keys()], [13]);
  assert.deepEqual(sizes.get(13), { additions: 5, deletions: 2, changedFiles: 1 });
});

test("asks for open pull requests in the order the REST list uses", () => {
  assert.match(PULL_SIZES_QUERY, /states: OPEN/);
  assert.match(PULL_SIZES_QUERY, /orderBy: \{ field: UPDATED_AT, direction: DESC \}/);
  assert.match(PULL_SIZES_QUERY, /number additions deletions changedFiles/);
});

test("reads the shape a successful GraphQL response returns", () => {
  const data = { repository: { pullRequests: { nodes: [{ number: 7, additions: 1, deletions: 2, changedFiles: 3 }] } } };

  assert.deepEqual(pullSizeMap(data).get(7), { additions: 1, deletions: 2, changedFiles: 3 });
});

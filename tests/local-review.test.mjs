import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../lib/diff.ts";
import { fileReplay, isLocalReviewSession, localBridgeFragment, localPullDetail, parseLocalBridge } from "../lib/local-review.ts";
import { isReplay } from "../lib/review-cache.ts";

const TOKEN = "Qdt5hScXaNehQB40BOLCCF6VQMXJHsS92NviI67mKQo";
const DIFF = [
  "diff --git a/lib/a.ts b/lib/a.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/a.ts",
  "+++ b/lib/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "",
].join("\n");

function session(overrides = {}) {
  return {
    format: "chronosphere.local-review", version: 1, id: "id", createdAt: "2026-11-03T00:00:00.000Z",
    repository: { name: "owner/repo", branch: "feature" },
    title: "Local changes on feature", body: "",
    base: { ref: "origin/main", sha: "a".repeat(40) },
    head: { sha: "b".repeat(40), commit: "c".repeat(40), uncommitted: true },
    commits: [], diff: DIFF, recording: null,
    ...overrides,
  };
}

test("review links only ever point at loopback", () => {
  assert.deepEqual(parseLocalBridge(`#port=53370&token=${TOKEN}`), { origin: "http://127.0.0.1:53370", token: TOKEN });
  // Extra parameters cannot redirect the page to another host.
  assert.equal(parseLocalBridge(`#port=53370&token=${TOKEN}&host=evil.example`)?.origin, "http://127.0.0.1:53370");
  assert.equal(parseLocalBridge(`#port=0&token=${TOKEN}`), null);
  assert.equal(parseLocalBridge(`#port=70000&token=${TOKEN}`), null);
  assert.equal(parseLocalBridge("#port=53370&token=short"), null);
  assert.equal(parseLocalBridge("#diff-lib%2Fa.ts-R2"), null);
  assert.equal(parseLocalBridge(localBridgeFragment({ origin: "http://127.0.0.1:4100", token: TOKEN }))?.origin, "http://127.0.0.1:4100");
});

test("sessions from the review command are recognised and malformed ones are not", () => {
  assert.equal(isLocalReviewSession(session()), true);
  assert.equal(isLocalReviewSession(session({ recording: { id: "r", name: "s.jsonl", source: "{}" } })), true);
  assert.equal(isLocalReviewSession(session({ recording: { name: "s.jsonl", source: "{}" } })), false);
  assert.equal(isLocalReviewSession(session({ version: 2 })), false);
  assert.equal(isLocalReviewSession(session({ head: { sha: "not-a-sha", commit: "c".repeat(40), uncommitted: false } })), false);
  assert.equal(isLocalReviewSession(session({ diff: undefined })), false);
});

test("a local snapshot fills the pull request shape the workspace renders", () => {
  const pull = localPullDetail(session());
  assert.equal(pull.baseSha, "a".repeat(40));
  assert.equal(pull.headSha, "b".repeat(40));
  assert.equal(pull.head, "feature");
  assert.equal(pull.base, "origin/main");
  assert.deepEqual([pull.additions, pull.deletions, pull.changedFiles], [3, 1, 2]);
  assert.deepEqual(pull.allowedMergeMethods, []);
});

test("without a recording, local changes play one valid step per file", () => {
  const files = parseUnifiedDiff(DIFF);
  const replay = fileReplay(files);
  assert.equal(isReplay(replay), true);
  assert.deepEqual(replay.chunks.map((chunk) => [chunk.title, chunk.ranges]), [
    ["Update a.ts", [{ file: "lib/a.ts", start: 1, end: 2 }]],
    ["Add notes.md", [{ file: "notes.md", start: 3, end: 4 }]],
  ]);
  assert.equal(replay.chunks[1].description, "notes.md: +2 −0");
});

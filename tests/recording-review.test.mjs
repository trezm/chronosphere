import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, parseRecording } from "../lib/recording.ts";
import { historicalReviewNote, recordedChangeDiff, recordedLineAnchor, recordingReplay } from "../lib/recording-review.ts";
import { parseUnifiedDiff } from "../lib/diff.ts";
import { isReplay, loadInProgressReview, saveInProgressReview } from "../lib/review-cache.ts";
import { isPullRequestState } from "../lib/review-state.ts";
import { PR_RECORDING_PATH, readRecordingResponse, withoutRecordingDiff } from "../lib/pr-recording.ts";

const file = async (content) => ({ content, sha256: await contentHash(content) });
const canonicalDiff = `diff --git a/math.js b/math.js
--- a/math.js
+++ b/math.js
@@ -1,3 +1,4 @@
 export function total(values) {
-  return values.length;
+  const count = values.reduce((a, b) => a + b, 0);
+  return count;
 }
`;

test("recorded file replacements render additions, removals and context with their actual line numbers", async () => {
  const change = { path: "math.js", before: await file("first\nold\nlast\n"), after: await file("first\nnew\nextra\nlast\n") };
  const result = recordedChangeDiff(change);
  assert.deepEqual(result.hunks[0].lines.map(({ type, text, oldLine, newLine }) => [type, text, oldLine, newLine]), [
    ["context", "first", 1, 1], ["delete", "old", 2, null], ["add", "new", null, 2], ["add", "extra", null, 3], ["context", "last", 3, 4],
  ]);
  assert.equal(recordedChangeDiff({ ...change, before: null }).status, "added");
  assert.equal(recordedChangeDiff({ ...change, after: null }).status, "deleted");
  assert.equal(recordedChangeDiff({ path: "empty", before: null, after: await file("") }).hunks.length, 0);
});

test("inline comments require a verified PR file version and an actual diff line", async () => {
  const change = { path: "math.js", before: await file("export function total(values) {\n  return values.length;\n}\n"), after: await file("export function total(values) {\n  const count = values.reduce((a, b) => a + b, 0);\n  return count;\n}\n") };
  const canonical = parseUnifiedDiff(canonicalDiff)[0];
  const rows = recordedChangeDiff(change).hunks[0].lines;
  const added = rows.find((row) => row.type === "add");
  const deleted = rows.find((row) => row.type === "delete");
  const hashes = { baseHash: change.before.sha256, headHash: change.after.sha256 };
  assert.deepEqual(recordedLineAnchor(change, added, canonical, hashes), { path: "math.js", line: 2, side: "RIGHT" });
  assert.deepEqual(recordedLineAnchor(change, deleted, canonical, hashes), { path: "math.js", line: 2, side: "LEFT" });
  assert.equal(recordedLineAnchor(change, added, canonical, {}), null);
  assert.equal(recordedLineAnchor(change, added, canonical, { headHash: "different version" }), null);
  assert.equal(recordedLineAnchor(change, { ...added, newLine: 88 }, canonical, hashes), null);
  assert.equal(recordedLineAnchor(change, { ...added, text: "different text" }, canonical, hashes), null);
  assert.equal(recordedLineAnchor(change, added, undefined, hashes), null);
  assert.deepEqual(recordedLineAnchor(change, deleted, { ...canonical, path: "renamed.js", oldPath: "math.js" }, hashes), { path: "renamed.js", line: 2, side: "LEFT" });
});

test("historical notes preserve the recording location without pretending to have a GitHub anchor", () => {
  const note = historicalReviewNote({ id: "event-1", sequence: 4, title: "Try a cache" }, "cache.js", 8, "RIGHT", "Please explain this choice.");
  assert.match(note, /Recorded step 4: Try a cache/);
  assert.match(note, /cache.js:8 \(after; historical version, event event-1\)/);
  assert.match(note, /Please explain this choice/);
});

test("recorded steps with no final diff ranges persist with review comments, without source snapshots", async () => {
  const before = await file("private source body\n");
  const session = { type: "session", format: "chronosphere.recording", version: 1, capture: "checkpoints", id: "session", title: "Record", createdAt: "2026-09-15T00:00:00Z", repository: { name: "repo", head: null, branch: "main" }, scope: ["."], baseline: { "app.js": before }, omitted: [] };
  const events = [{ type: "finish", id: "finish", sequence: 1, recordedAt: "2026-09-15T00:01:00Z", title: "Done", reason: "Tests pass", changes: [], omitted: [] }];
  const recording = await parseRecording([session, ...events].map(JSON.stringify).join("\n"));
  const replay = recordingReplay(recording, "example.jsonl");
  assert.equal(isReplay(replay), true);
  assert.equal(replay.chunks.length, 2);
  assert.equal(JSON.stringify(replay).includes("private source body"), false);
  assert.equal(isReplay({ ...replay, source: undefined }), false);
  const state = { headSha: "a".repeat(40), replay, step: 1, model: "test", showFullDiff: false, review: { comments: [{ id: "c", path: "app.js", line: 2, side: "RIGHT", body: "Check this", step: 1 }], summary: "Historical note", event: "COMMENT" } };
  assert.equal(isPullRequestState(state), true);
  const storage = new Map();
  const adapter = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const review = { ...state, ...state.review };
  saveInProgressReview(adapter, "key", review);
  const restored = loadInProgressReview(adapter, "key", state.headSha);
  assert.equal(restored.replay.recordingId, "session");
  assert.deepEqual(restored.comments, state.review.comments);
  assert.equal(restored.summary, "Historical note");
});

test("the committed recording is excluded from code diffs without dropping adjacent files", () => {
  const artifact = `diff --git a/${PR_RECORDING_PATH} b/${PR_RECORDING_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${PR_RECORDING_PATH}\n@@ -0,0 +1 @@\n+recording content\n`;
  const second = canonicalDiff.replaceAll("math.js", "other.js");
  assert.equal(withoutRecordingDiff(artifact + canonicalDiff), canonicalDiff);
  assert.equal(withoutRecordingDiff(canonicalDiff + artifact + second), canonicalDiff + second);
  assert.equal(withoutRecordingDiff(artifact), "");
});

test("committed-recording downloads enforce byte limits even without a content-length header", async () => {
  assert.equal(await readRecordingResponse(new Response("héllo")), "héllo");
  await assert.rejects(readRecordingResponse(new Response("123456", { headers: { "content-length": "6" } }), 5), /limit/);
  await assert.rejects(readRecordingResponse(new Response("123456"), 5), /limit/);
  await assert.rejects(readRecordingResponse(new Response(new Uint8Array([0xff]))), /encoded|encoding/i);
});

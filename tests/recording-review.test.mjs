import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, parseRecording } from "../lib/recording.ts";
import { finalLineMaps, historicalReviewNote, lineMatches, recordedChangeDiff, recordedLineAnchor, recordingReplay } from "../lib/recording-review.ts";
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

test("line matching pairs unchanged lines across edits and gives up past the edit budget", () => {
  assert.deepEqual([...lineMatches(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])], [0, -1, 2, 3]);
  assert.deepEqual([...lineMatches(["a", "b"], ["z", "a", "b"])], [1, 2]);
  assert.deepEqual([...lineMatches(["q", "a", "r", "b", "s"], ["a", "b"])], [-1, 0, -1, 1, -1]);
  assert.deepEqual([...lineMatches([], ["a"])], []);
  assert.deepEqual([...lineMatches(["a"], [])], [-1]);
  assert.equal(lineMatches(["a", "b", "c"], ["x", "y", "z"], 2), null);
});

test("inline comments anchor recorded lines that survive unchanged into the final PR diff", async () => {
  const base = "export function total(values) {\n  return values.length;\n}\n";
  const head = "export function total(values) {\n  const count = values.reduce((a, b) => a + b, 0);\n  return count;\n}\n";
  const canonical = parseUnifiedDiff(canonicalDiff)[0];
  const exact = { path: "math.js", before: await file(base), after: await file(head) };
  const exactRows = recordedChangeDiff(exact).hunks[0].lines;
  const added = exactRows.find((row) => row.type === "add");
  const deleted = exactRows.find((row) => row.type === "delete");
  const maps = finalLineMaps(exact, { base, head });
  assert.deepEqual(recordedLineAnchor(added, canonical, maps), { path: "math.js", line: 2, side: "RIGHT" });
  assert.deepEqual(recordedLineAnchor(deleted, canonical, maps), { path: "math.js", line: 2, side: "LEFT" });
  assert.equal(recordedLineAnchor(added, canonical, {}), null);
  assert.equal(recordedLineAnchor(added, undefined, maps), null);
  assert.deepEqual(recordedLineAnchor(deleted, { ...canonical, path: "renamed.js", oldPath: "math.js" }, maps), { path: "renamed.js", line: 2, side: "LEFT" });

  // An intermediate checkpoint: the file differs from the final head, but lines kept later still anchor.
  const draft = "// TODO\nexport function total(values) {\n  const count = values.reduce((a, b) => a + b, 0);\n  console.log(count);\n  return count;\n}\n";
  const step = { path: "math.js", before: await file(base), after: await file(draft) };
  const stepMaps = finalLineMaps(step, { base, head });
  const stepRows = recordedChangeDiff(step).hunks[0].lines;
  const kept = stepRows.find((row) => row.type === "add" && row.text.includes("reduce"));
  const laterRemoved = stepRows.find((row) => row.type === "add" && row.text.includes("console.log"));
  const shifted = stepRows.find((row) => row.type === "add" && row.text === "  return count;");
  assert.deepEqual(recordedLineAnchor(kept, canonical, stepMaps), { path: "math.js", line: 2, side: "RIGHT" });
  assert.deepEqual(recordedLineAnchor(shifted, canonical, stepMaps), { path: "math.js", line: 3, side: "RIGHT" });
  assert.equal(recordedLineAnchor(laterRemoved, canonical, stepMaps), null);
  assert.equal(recordedLineAnchor(stepRows.find((row) => row.text === "// TODO"), canonical, stepMaps), null);

  // A line deleted from something an earlier step wrote was never in the PR base.
  const revert = { path: "math.js", before: await file(draft), after: await file(head) };
  const revertRows = recordedChangeDiff(revert).hunks[0].lines;
  assert.equal(recordedLineAnchor(revertRows.find((row) => row.type === "delete" && row.text.includes("console.log")), canonical, finalLineMaps(revert, { base, head })), null);
});

test("historical notes preserve the recording location without pretending to have a GitHub anchor", () => {
  const note = historicalReviewNote({ id: "event-1", sequence: 4, title: "Try a cache" }, "cache.js", 8, "RIGHT", "Please explain this choice.");
  assert.match(note, /Recorded step 4: Try a cache/);
  assert.match(note, /cache.js:8 \(after; historical version, event event-1\)/);
  assert.match(note, /could not be placed inline/);
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

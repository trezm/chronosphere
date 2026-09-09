import assert from "node:assert/strict";
import test from "node:test";
import { chunkFiles, inRanges, normalizeReplayChunks, parseUnifiedDiff, replayStepMap } from "../lib/diff.ts";

const sample = `diff --git a/src/math.ts b/src/math.ts
index 1111111..2222222 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@
 export function total(values: number[]) {
-  return values.length;
+  const valid = values.filter(Number.isFinite);
+  return valid.reduce((sum, value) => sum + value, 0);
 }
`;

test("parses and numbers changed lines in a unified diff", () => {
  const files = parseUnifiedDiff(sample);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/math.ts");
  assert.deepEqual(
    files[0].hunks[0].lines.filter((line) => line.changedIndex).map((line) => [line.type, line.changedIndex]),
    [["delete", 1], ["add", 2], ["add", 3]],
  );
});

test("normalizes incomplete model output so every changed line is replayed", () => {
  const files = parseUnifiedDiff(sample);
  const chunks = normalizeReplayChunks(
    [{ start: 2, end: 3, title: "Use valid values", description: "Adds the implementation." }],
    files,
  );
  const map = replayStepMap(chunks);
  assert.equal(map.size, 3);
  assert.ok([...map.keys()].every((index) => index >= 1 && index <= 3));
});

test("maps changed lines to their reconstructed step rather than diff order", () => {
  const files = parseUnifiedDiff(sample);
  const chunks = normalizeReplayChunks(
    [
      { start: 2, end: 3, title: "Add the replacement", description: "Adds the new implementation." },
      { start: 1, end: 1, title: "Remove the old return", description: "Removes the old implementation." },
    ],
    files,
  );
  const map = replayStepMap(chunks);

  assert.equal(map.get(2), 0);
  assert.equal(map.get(3), 0);
  assert.equal(map.get(1), 1);
});

test("preserves explicit model impact markings and defaults other steps to false", () => {
  const files = parseUnifiedDiff(sample);
  const chunks = normalizeReplayChunks(
    [
      { start: 2, end: 3, title: "Add the core calculation", description: "Changes the result.", impactful: true },
      { start: 1, end: 1, title: "Remove the old return", description: "Removes the old implementation." },
    ],
    files,
  );

  assert.equal(chunks[0].impactful, true);
  assert.equal(chunks[1].impactful, false);
});

const twoFiles = `diff --git a/src/shape.ts b/src/shape.ts
new file mode 100644
--- /dev/null
+++ b/src/shape.ts
@@ -0,0 +1,3 @@
+export interface Shape {
+  area(): number;
+}
diff --git a/src/circle.ts b/src/circle.ts
new file mode 100644
--- /dev/null
+++ b/src/circle.ts
@@ -0,0 +1,4 @@
+import type { Shape } from "./shape";
+export class Circle implements Shape {
+  area() { return 1; }
+}
`;

test("keeps ranges from several files together in one step", () => {
  const files = parseUnifiedDiff(twoFiles);
  const chunks = normalizeReplayChunks(
    [{ ranges: [{ start: 1, end: 3 }, { start: 5, end: 7 }], title: "Shape and Circle", description: "Defines the interface and its implementation." }],
    files,
  );

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].ranges, [
    { file: "src/shape.ts", start: 1, end: 3 },
    { file: "src/circle.ts", start: 5, end: 7 },
  ]);
  assert.deepEqual(chunkFiles(chunks[0]), ["src/shape.ts", "src/circle.ts"]);
  assert.equal(chunks[1].title, "Remaining changes");
  assert.deepEqual(chunks[1].ranges, [{ file: "src/circle.ts", start: 4, end: 4 }]);
  assert.equal(replayStepMap(chunks).get(4), 1);
  assert.equal(replayStepMap(chunks).get(6), 0);
});

test("splits a range that crosses a file boundary into one range per file", () => {
  const files = parseUnifiedDiff(twoFiles);
  const chunks = normalizeReplayChunks([{ start: 2, end: 5, title: "Straddle", description: "" }], files);

  assert.deepEqual(chunks[0].ranges, [
    { file: "src/shape.ts", start: 2, end: 3 },
    { file: "src/circle.ts", start: 4, end: 5 },
  ]);
});

test("drops overlapping lines and steps with nothing left to claim", () => {
  const files = parseUnifiedDiff(twoFiles);
  const chunks = normalizeReplayChunks(
    [
      { ranges: [{ start: 1, end: 7 }], title: "Everything", description: "" },
      { ranges: [{ start: 2, end: 3 }], title: "Duplicate", description: "" },
      { ranges: [], title: "Empty", description: "" },
    ],
    files,
  );

  assert.deepEqual(chunks.map((chunk) => chunk.title), ["Everything"]);
  assert.equal(replayStepMap(chunks).size, 7);
});

test("inRanges only matches numbered lines inside a range", () => {
  const ranges = [{ file: "a.ts", start: 2, end: 3 }, { file: "b.ts", start: 9, end: 9 }];
  assert.equal(inRanges(ranges, 2), true);
  assert.equal(inRanges(ranges, 9), true);
  assert.equal(inRanges(ranges, 4), false);
  assert.equal(inRanges(ranges, null), false);
});

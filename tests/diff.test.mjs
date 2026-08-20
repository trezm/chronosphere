import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReplayChunks, parseUnifiedDiff, replayStepMap } from "../lib/diff.ts";

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

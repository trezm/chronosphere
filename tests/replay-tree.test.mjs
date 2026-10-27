import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff, replayStepMap } from "../lib/diff.ts";
import { hasValidTreeParents, normalizeReplayTree, subtreeRanges, subtreeSteps, treeChildren, treeOutline, treePath, treeRoots } from "../lib/replay-tree.ts";
import { isReplay } from "../lib/review-cache.ts";

// Three files, nine changed lines: model (1–3), service (4–6), handler (7–9).
const diff = `diff --git a/src/model.ts b/src/model.ts
new file mode 100644
--- /dev/null
+++ b/src/model.ts
@@ -0,0 +1,3 @@
+export interface User {
+  id: string;
+}
diff --git a/src/service.ts b/src/service.ts
new file mode 100644
--- /dev/null
+++ b/src/service.ts
@@ -0,0 +1,3 @@
+import type { User } from "./model";
+export function find(id: string): User {
+  return { id };
diff --git a/src/handler.ts b/src/handler.ts
new file mode 100644
--- /dev/null
+++ b/src/handler.ts
@@ -0,0 +1,3 @@
+import { find } from "./service";
+export const handle = (id: string) =>
+  find(id);
`;
const files = parseUnifiedDiff(diff);

const node = (id, parent, start, end, title = id) => ({ id, parent, ranges: [{ start, end }], title, description: "" });

test("orders nodes children first and links them by index", () => {
  // The model lists the root first; the result must put prerequisites before it.
  const chunks = normalizeReplayTree([
    node("handler", null, 7, 9),
    node("service", "handler", 4, 6),
    node("model", "service", 1, 3),
  ], files);
  assert.deepEqual(chunks.map((chunk) => [chunk.title, chunk.parent]), [["model", 1], ["service", 2], ["handler", null]]);
  assert.ok(hasValidTreeParents(chunks));
  assert.equal(replayStepMap(chunks).size, 9);
});

test("keeps sibling order and supports several leaves under one parent", () => {
  const chunks = normalizeReplayTree([
    node("model", "handler", 1, 3),
    node("service", "handler", 4, 6),
    node("handler", null, 7, 9),
  ], files);
  assert.deepEqual(chunks.map((chunk) => chunk.title), ["model", "service", "handler"]);
  assert.deepEqual(treeChildren(chunks), [[], [], [0, 1]]);
  assert.deepEqual(treeRoots(chunks), [2]);
});

test("re-parents children of a node that claimed no lines to its nearest surviving ancestor", () => {
  const chunks = normalizeReplayTree([
    node("handler", null, 7, 9),
    // Claims lines the handler already took, so it is dropped.
    node("service", "handler", 8, 9),
    node("model", "service", 1, 6),
  ], files);
  assert.deepEqual(chunks.map((chunk) => [chunk.title, chunk.parent]), [["model", 1], ["handler", null]]);
});

test("treats unknown and self parents as roots and cuts cycles", () => {
  const unknown = normalizeReplayTree([node("a", "missing", 1, 3), node("b", "b", 4, 9)], files);
  assert.deepEqual(unknown.map((chunk) => chunk.parent), [null, null]);

  const cyclic = normalizeReplayTree([node("a", "b", 1, 3), node("b", "c", 4, 6), node("c", "a", 7, 9)], files);
  assert.ok(hasValidTreeParents(cyclic));
  assert.equal(treeRoots(cyclic).length, 1);
  assert.equal(replayStepMap(cyclic).size, 9);
});

test("attaches lines the model left out beneath the single root", () => {
  const chunks = normalizeReplayTree([node("handler", null, 7, 9), node("model", "handler", 1, 3)], files);
  const remaining = chunks.find((chunk) => chunk.title === "Remaining changes");
  assert.ok(remaining);
  assert.equal(chunks[remaining.parent].title, "handler");
  assert.equal(replayStepMap(chunks).size, 9);
  assert.ok(hasValidTreeParents(chunks));
});

test("walks subtrees, paths and the outline", () => {
  const chunks = normalizeReplayTree([
    node("handler", null, 7, 9),
    node("service", "handler", 4, 6),
    node("model", "service", 1, 3),
  ], files);
  assert.deepEqual(subtreeSteps(chunks, 1), [0, 1]);
  assert.deepEqual(subtreeRanges(chunks, 2).map((range) => range.file), ["src/model.ts", "src/service.ts", "src/handler.ts"]);
  assert.deepEqual(treePath(chunks, 0), [2, 1, 0]);
  assert.deepEqual(treeOutline(chunks), [{ step: 2, depth: 0 }, { step: 1, depth: 1 }, { step: 0, depth: 2 }]);
});

test("stored tree replays must keep parents after their children", () => {
  const chunk = (parent) => ({ ranges: [{ file: "a", start: 1, end: 1 }], title: "t", description: "", parent });
  assert.ok(isReplay({ layout: "tree", model: "m", truncated: false, chunks: [chunk(1), chunk(null)] }));
  assert.equal(isReplay({ layout: "tree", model: "m", truncated: false, chunks: [chunk(null), chunk(0)] }), false);
  assert.equal(isReplay({ layout: "graph", model: "m", truncated: false, chunks: [chunk(null)] }), false);
  // Linear replays from before trees existed still load.
  assert.ok(isReplay({ model: "m", truncated: false, chunks: [{ ranges: [{ file: "a", start: 1, end: 1 }], title: "t", description: "" }] }));
});

import { normalizeReplayChunksWithSources, type RawReplayChunk } from "./diff.ts";
import type { DiffFile, ReplayChunk, ReplayRange, ReplayResult } from "./types";

/**
 * Dependency-tree replays.
 *
 * A tree replay is an ordinary replay whose chunks also carry a `parent`: the
 * step that relies on them. Chunks are stored children first (post-order), so
 * every parent index is greater than its children's and the array order is
 * still a valid build order for anything that walks steps linearly.
 */

export function isTreeReplay(replay: Pick<ReplayResult, "layout"> | null | undefined): boolean {
  return replay?.layout === "tree";
}

/** True when every parent points later in the array, which also rules out cycles. */
export function hasValidTreeParents(chunks: ReadonlyArray<Pick<ReplayChunk, "parent">>): boolean {
  return chunks.every((chunk, index) => chunk.parent === undefined || chunk.parent === null
    || (Number.isInteger(chunk.parent) && chunk.parent > index && chunk.parent < chunks.length));
}

/**
 * Turns the model's nodes, which name their parent by id, into post-ordered
 * chunks with index parents. Every changed line is still covered exactly once:
 * nodes that claim no lines are skipped and their children attach to the
 * nearest surviving ancestor, cycles are cut, and leftover lines become
 * prerequisites of the root.
 */
export function normalizeReplayTree(raw: RawReplayChunk[], files: DiffFile[]): ReplayChunk[] {
  const nodes = raw ?? [];
  const { chunks, sources } = normalizeReplayChunksWithSources(nodes, files);
  if (!chunks.length) return [];

  const rawIndexById = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!node || typeof node !== "object" || node.id === undefined || node.id === null) return;
    const id = String(node.id);
    if (!rawIndexById.has(id)) rawIndexById.set(id, index);
  });
  const rawParent = (index: number): number | null => {
    const parent = nodes[index]?.parent;
    if (parent === undefined || parent === null) return null;
    const found = rawIndexById.get(String(parent));
    return found === undefined || found === index ? null : found;
  };
  const chunkByRaw = new Map<number, number>();
  sources.forEach((source, index) => { if (source !== null) chunkByRaw.set(source, index); });

  // Resolve each node's parent to the nearest ancestor that kept some lines.
  const parent: Array<number | null> = sources.map((source) => {
    if (source === null) return null;
    const seen = new Set([source]);
    let candidate = rawParent(source);
    while (candidate !== null && !chunkByRaw.has(candidate)) {
      if (seen.has(candidate)) return null;
      seen.add(candidate);
      candidate = rawParent(candidate);
    }
    return candidate === null ? null : chunkByRaw.get(candidate)!;
  });

  // Cut the edge that closes any cycle, so every walk upward ends at a root.
  for (let start = 0; start < parent.length; start++) {
    const path = new Set<number>();
    let node: number | null = start;
    while (node !== null && !path.has(node)) {
      path.add(node);
      const next: number | null = parent[node];
      if (next !== null && path.has(next)) { parent[node] = null; break; }
      node = next;
    }
  }

  // Lines the model left out are something the finished work relies on.
  const modelRoots = parent.filter((value, index) => value === null && sources[index] !== null).length;
  const soleRoot = modelRoots === 1 ? parent.findIndex((value, index) => value === null && sources[index] !== null) : -1;
  sources.forEach((source, index) => { if (source === null && soleRoot >= 0) parent[index] = soleRoot; });

  // Re-order children first, keeping the model's order among siblings.
  const children = parent.map(() => [] as number[]);
  const roots: number[] = [];
  parent.forEach((value, index) => (value === null ? roots : children[value]).push(index));
  const order: number[] = [];
  const visit = (index: number) => {
    for (const child of children[index]) visit(child);
    order.push(index);
  };
  roots.forEach(visit);
  const position = new Map(order.map((index, at) => [index, at]));
  return order.map((index) => ({ ...chunks[index], parent: parent[index] === null ? null : position.get(parent[index]!)! }));
}

/** The direct prerequisites of every step, in build order. */
export function treeChildren(chunks: ReadonlyArray<Pick<ReplayChunk, "parent">>): number[][] {
  const children = chunks.map(() => [] as number[]);
  chunks.forEach((chunk, index) => {
    if (typeof chunk.parent === "number" && children[chunk.parent]) children[chunk.parent].push(index);
  });
  return children;
}

/** Steps that nothing else relies on. */
export function treeRoots(chunks: ReadonlyArray<Pick<ReplayChunk, "parent">>): number[] {
  return chunks.flatMap((chunk, index) => typeof chunk.parent === "number" ? [] : [index]);
}

/** A step and everything beneath it, in build order (prerequisites first). */
export function subtreeSteps(chunks: ReadonlyArray<Pick<ReplayChunk, "parent">>, index: number): number[] {
  const children = treeChildren(chunks);
  const steps: number[] = [];
  const visit = (node: number) => {
    for (const child of children[node] ?? []) visit(child);
    steps.push(node);
  };
  if (index >= 0 && index < chunks.length) visit(index);
  return steps;
}

/** The ranges of a step and all of its prerequisites. */
export function subtreeRanges(chunks: ReadonlyArray<Pick<ReplayChunk, "parent" | "ranges">>, index: number): ReplayRange[] {
  return subtreeSteps(chunks, index).flatMap((step) => chunks[step].ranges);
}

/** The steps from a root down to (and including) the given step. */
export function treePath(chunks: ReadonlyArray<Pick<ReplayChunk, "parent">>, index: number): number[] {
  const path: number[] = [];
  let node: number | null | undefined = index;
  // Parents only point forward, so this ends within chunks.length hops.
  while (typeof node === "number" && node >= 0 && node < chunks.length && path.length <= chunks.length) {
    path.unshift(node);
    node = chunks[node].parent;
  }
  return path;
}

/** Steps in outline order, root first, with their depth below it. */
export function treeOutline(chunks: ReadonlyArray<Pick<ReplayChunk, "parent">>): Array<{ step: number; depth: number }> {
  const children = treeChildren(chunks);
  const outline: Array<{ step: number; depth: number }> = [];
  const visit = (step: number, depth: number) => {
    outline.push({ step, depth });
    for (const child of children[step]) visit(child, depth + 1);
  };
  treeRoots(chunks).forEach((root) => visit(root, 0));
  return outline;
}

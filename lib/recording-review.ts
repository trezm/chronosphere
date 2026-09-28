import type { DiffFile, DiffLine, PendingComment, ReplayResult } from "./types";
import type { RecordedChange, Recording, RecordingEvent } from "./recording";

export type ReviewAnchor = Pick<PendingComment, "path" | "line" | "side">;

/** Persist only the timeline metadata, never the uploaded workspace snapshots. */
export function recordingReplay(recording: Recording, name: string): ReplayResult {
  return {
    source: "recording", recordingId: recording.session.id, recordingName: name,
    model: "Recorded checkpoints", truncated: false,
    chunks: [
      { title: "Starting snapshot", description: `Recording began with ${Object.keys(recording.session.baseline).length} text files. Earlier edits are not recorded.`, ranges: [], files: [] },
      ...recording.events.map((event) => ({ title: event.title, description: event.reason, ranges: [], files: event.changes.map((change) => change.path) })),
    ],
  };
}

function lines(content: string | undefined): string[] {
  if (!content) return [];
  const values = content.replace(/\r\n/g, "\n").split("\n");
  if (values.at(-1) === "") values.pop();
  return values;
}

/** A bounded, exact replacement hunk. Unchanged prefix/suffix are context. */
export function recordedChangeDiff(change: RecordedChange): DiffFile {
  const before = lines(change.before?.content), after = lines(change.after?.content);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3);
  const rows: DiffLine[] = [];
  let changedIndex = 0;
  for (let i = start; i < prefix; i++) rows.push({ type: "context", text: before[i], oldLine: i + 1, newLine: i + 1, changedIndex: null });
  for (let i = prefix; i < before.length - suffix; i++) rows.push({ type: "delete", text: before[i], oldLine: i + 1, newLine: null, changedIndex: ++changedIndex });
  for (let i = prefix; i < after.length - suffix; i++) rows.push({ type: "add", text: after[i], oldLine: null, newLine: i + 1, changedIndex: ++changedIndex });
  for (let i = 0; i < Math.min(3, suffix); i++) rows.push({ type: "context", text: after[after.length - suffix + i], oldLine: before.length - suffix + i + 1, newLine: after.length - suffix + i + 1, changedIndex: null });
  const oldCount = rows.filter((row) => row.oldLine !== null).length;
  const newCount = rows.filter((row) => row.newLine !== null).length;
  return {
    path: change.path, oldPath: null,
    status: change.before === null ? "added" : change.after === null ? "deleted" : "modified",
    hunks: rows.length ? [{ header: `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@`, lines: rows }] : [],
  };
}

/**
 * Map each line of `a` to its matching line in `b` (or -1) using a Myers line diff.
 * Returns null when the files differ by more than `maxEdits` lines, rather than guessing.
 */
export function lineMatches(a: readonly string[], b: readonly string[], maxEdits = 2000): Int32Array | null {
  const map = new Int32Array(a.length).fill(-1);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) { map[start] = start; start++; }
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) map[--endA] = --endB;
  const n = endA - start, m = endB - start;
  if (!n || !m) return map;
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];
  let edits = -1;
  for (let d = 0; d <= Math.min(n + m, maxEdits) && edits < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { edits = d; break; }
    }
  }
  if (edits < 0) return null;
  let x = n, y = m;
  for (let d = edits; d > 0; d--) {
    const previous = trace[d], at = (k: number) => previous[k + d];
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK), previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x--; y--; map[start + x] = start + y; }
    x = previousX; y = previousY;
  }
  while (x > 0 && y > 0) { x--; y--; map[start + x] = start + y; }
  return map;
}

/** Line correspondences from a recorded checkpoint to the PR's final base and head files. */
export interface FinalLineMaps { before?: Int32Array | null; after?: Int32Array | null }

export function finalLineMaps(change: RecordedChange, final: { base?: string; head?: string }): FinalLineMaps {
  return {
    before: change.before && final.base !== undefined ? lineMatches(lines(change.before.content), lines(final.base)) : null,
    after: change.after && final.head !== undefined ? lineMatches(lines(change.after.content), lines(final.head)) : null,
  };
}

/**
 * Anchor a recorded line inline when it survives unchanged into the final PR: an after-side line
 * that is still present in the head file, or a before-side line that is the base file's own line.
 * The mapped line must also appear in the PR diff, since GitHub only accepts comments there.
 */
export function recordedLineAnchor(line: DiffLine, canonical: DiffFile | undefined, maps: FinalLineMaps): ReviewAnchor | null {
  if (!canonical) return null;
  const candidates = canonical.hunks.flatMap((hunk) => hunk.lines);
  const head = line.type !== "delete" && line.newLine !== null ? maps.after?.[line.newLine - 1] ?? -1 : -1;
  if (head >= 0 && candidates.some((row) => row.newLine === head + 1 && row.type !== "delete" && row.text === line.text)) {
    return { path: canonical.path, line: head + 1, side: "RIGHT" };
  }
  const base = line.type !== "add" && line.oldLine !== null ? maps.before?.[line.oldLine - 1] ?? -1 : -1;
  if (base >= 0 && candidates.some((row) => row.oldLine === base + 1 && row.type !== "add" && row.text === line.text)) {
    return { path: canonical.path, line: base + 1, side: "LEFT" };
  }
  return null;
}

export function historicalReviewNote(event: Pick<RecordingEvent, "title" | "sequence" | "id">, path: string, line: number, side: string, body: string): string {
  return `Recorded step ${event.sequence}: ${event.title}\nFile: ${path}:${line} (${side === "LEFT" ? "before" : "after"}; historical version, event ${event.id})\n> ⚠️ This line does not appear unchanged in the final PR diff, so this comment could not be placed inline.\n\n${body.trim()}`;
}

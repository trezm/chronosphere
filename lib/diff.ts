import type { DiffFile, DiffHunk, DiffLine, ReplayChunk, ReplayRange } from "./types";

function cleanPath(path: string): string {
  return path.replace(/^[ab]\//, "").replace(/^"|"$/g, "");
}

/** Indices into the original hunk, preserving replay and comment coordinates. */
export interface SideBySideRow {
  left: number | null;
  right: number | null;
}

export function sideBySideRows(lines: readonly DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let deleted: number[] = [];
  let added: number[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(deleted.length, added.length); index++) {
      rows.push({ left: deleted[index] ?? null, right: added[index] ?? null });
    }
    deleted = [];
    added = [];
  };
  lines.forEach((line, index) => {
    if (line.type === "context") {
      flush();
      rows.push({ left: index, right: index });
    } else if (line.type === "delete") {
      // An insertion followed by a deletion starts another replacement block.
      if (added.length) flush();
      deleted.push(index);
    } else {
      added.push(index);
    }
  });
  flush();
  return rows;
}

/** In a step-scoped diff, unchanged context and this step's changes remain visible. */
export function stepLineVisible(line: DiffLine, ranges: readonly ReplayRange[]): boolean {
  return line.changedIndex === null || inRanges(ranges, line.changedIndex);
}

/** Keep original hunk indexes so comments and syntax tokens still use PR coordinates. */
export function sideBySideStepRows(lines: readonly DiffLine[], ranges: readonly ReplayRange[]): SideBySideRow[] {
  return sideBySideRows(lines)
    .map((row) => ({
      left: row.left !== null && stepLineVisible(lines[row.left], ranges) ? row.left : null,
      right: row.right !== null && stepLineVisible(lines[row.right], ranges) ? row.right : null,
    }))
    .filter((row) => row.left !== null || row.right !== null);
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let changedIndex = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = raw.match(/^diff --git (.+?) (.+)$/);
      file = {
        oldPath: match ? cleanPath(match[1]) : null,
        path: match ? cleanPath(match[2]) : "unknown",
        status: "modified",
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("new file mode")) file.status = "added";
    if (raw.startsWith("deleted file mode")) file.status = "deleted";
    if (raw.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = cleanPath(raw.slice("rename from ".length));
    }
    if (raw.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = cleanPath(raw.slice("rename to ".length));
    }
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      if (path !== "/dev/null") file.path = cleanPath(path);
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith("\\ No newline")) continue;

    let line: DiffLine | null = null;
    if (raw.startsWith("+")) {
      changedIndex++;
      line = { type: "add", text: raw.slice(1), oldLine: null, newLine, changedIndex };
      newLine++;
    } else if (raw.startsWith("-")) {
      changedIndex++;
      line = { type: "delete", text: raw.slice(1), oldLine, newLine: null, changedIndex };
      oldLine++;
    } else if (raw.startsWith(" ")) {
      line = { type: "context", text: raw.slice(1), oldLine, newLine, changedIndex: null };
      oldLine++;
      newLine++;
    }
    if (line) hunk.lines.push(line);
  }

  return files.filter((candidate) => candidate.hunks.length > 0);
}

export function changedLines(files: DiffFile[]): Array<{ file: DiffFile; line: DiffLine }> {
  return files.flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.changedIndex !== null)
        .map((line) => ({ file, line }))
    )
  );
}

/** The shapes the model may use for one step's line coverage. */
export interface RawReplayChunk {
  /** Legacy single range. */
  start?: unknown;
  end?: unknown;
  /** Several ranges, possibly in different files, shown together. */
  ranges?: unknown;
  title?: unknown;
  description?: unknown;
  impactful?: unknown;
  /** Tree replays: the model's name for this node and for the node that relies on it. */
  id?: unknown;
  parent?: unknown;
}

function candidateRanges(candidate: RawReplayChunk, total: number): Array<{ start: number; end: number }> {
  const raw: Array<{ start?: unknown; end?: unknown }> = Array.isArray(candidate.ranges) ? candidate.ranges : [];
  if (candidate.start !== undefined || candidate.end !== undefined) raw.push({ start: candidate.start, end: candidate.end });
  const ranges: Array<{ start: number; end: number }> = [];
  for (const range of raw) {
    if (!range || typeof range !== "object") continue;
    const a = Math.floor(Number(range.start));
    const b = Math.floor(Number(range.end));
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const start = Math.max(1, Math.min(a, b));
    const end = Math.min(total, Math.max(a, b));
    if (start <= end) ranges.push({ start, end });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

export function normalizeReplayChunks(
  raw: RawReplayChunk[],
  files: DiffFile[]
): ReplayChunk[] {
  return normalizeReplayChunksWithSources(raw, files).chunks;
}

/**
 * Like normalizeReplayChunks, and also reports which model candidate each step
 * came from: an index into `raw`, or null for the "Remaining changes" steps.
 */
export function normalizeReplayChunksWithSources(
  raw: RawReplayChunk[],
  files: DiffFile[]
): { chunks: ReplayChunk[]; sources: Array<number | null> } {
  const changed = changedLines(files);
  if (changed.length === 0) return { chunks: [], sources: [] };
  const claimed = new Set<number>();
  const chunks: ReplayChunk[] = [];
  const sources: Array<number | null> = [];

  /**
   * Claims every still-unclaimed line in [start, end], split into contiguous
   * single-file segments, so a range that straddles a file boundary or an
   * already-claimed line still becomes valid ranges.
   */
  const claimRange = (start: number, end: number): ReplayRange[] => {
    const ranges: ReplayRange[] = [];
    let segmentStart: number | null = null;
    let segmentFile = "";
    const close = (segmentEnd: number) => {
      if (segmentStart === null) return;
      ranges.push({ file: segmentFile, start: segmentStart, end: segmentEnd });
      segmentStart = null;
    };
    for (let index = start; index <= end; index++) {
      const entry = changed[index - 1];
      if (!entry || claimed.has(index)) {
        close(index - 1);
        continue;
      }
      if (segmentStart !== null && entry.file.path !== segmentFile) close(index - 1);
      if (segmentStart === null) {
        segmentStart = index;
        segmentFile = entry.file.path;
      }
      claimed.add(index);
    }
    close(end);
    return ranges;
  };

  (raw ?? []).forEach((candidate, source) => {
    if (!candidate || typeof candidate !== "object") return;
    const ranges = candidateRanges(candidate, changed.length).flatMap((range) => claimRange(range.start, range.end));
    if (!ranges.length) return;
    sources.push(source);
    chunks.push({
      ranges,
      title: String(candidate.title ?? "").trim() || "Implementation step",
      description: String(candidate.description ?? "").trim(),
      impactful: candidate.impactful === true,
    });
  });

  for (let index = 1; index <= changed.length; index++) {
    if (claimed.has(index)) continue;
    const path = changed[index - 1].file.path;
    let end = index;
    while (
      end + 1 <= changed.length &&
      !claimed.has(end + 1) &&
      changed[end].file.path === path
    ) {
      end++;
    }
    sources.push(null);
    chunks.push({
      ranges: claimRange(index, end),
      title: "Remaining changes",
      description: "Changes the model did not include in another step.",
      impactful: false,
    });
    index = end;
  }

  return { chunks, sources };
}

/** The distinct files a step touches, in the order its ranges visit them. */
export function chunkFiles(chunk: Pick<ReplayChunk, "ranges">): string[] {
  const files: string[] = [];
  for (const range of chunk.ranges) if (!files.includes(range.file)) files.push(range.file);
  return files;
}

/** Whether a numbered changed line belongs to one of the given ranges. */
export function inRanges(ranges: readonly ReplayRange[], changedIndex: number | null): boolean {
  if (changedIndex === null) return false;
  return ranges.some((range) => changedIndex >= range.start && changedIndex <= range.end);
}

export function replayStepMap(chunks: ReplayChunk[]): Map<number, number> {
  const map = new Map<number, number>();
  chunks.forEach((chunk, step) => {
    for (const range of chunk.ranges) {
      for (let index = range.start; index <= range.end; index++) map.set(index, step);
    }
  });
  return map;
}

import type { DiffFile, DiffHunk, DiffLine, ReplayChunk } from "./types";

function cleanPath(path: string): string {
  return path.replace(/^[ab]\//, "").replace(/^"|"$/g, "");
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

export function normalizeReplayChunks(
  raw: Array<Partial<ReplayChunk>>,
  files: DiffFile[]
): ReplayChunk[] {
  const changed = changedLines(files);
  if (changed.length === 0) return [];
  const claimed = new Set<number>();
  const chunks: ReplayChunk[] = [];

  const addRange = (start: number, end: number, title: string, description: string) => {
    let segmentStart: number | null = null;
    let segmentFile = "";
    const close = (segmentEnd: number) => {
      if (segmentStart === null) return;
      chunks.push({ file: segmentFile, start: segmentStart, end: segmentEnd, title, description });
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
  };

  for (const candidate of raw ?? []) {
    const a = Math.floor(Number(candidate.start));
    const b = Math.floor(Number(candidate.end));
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const start = Math.max(1, Math.min(a, b));
    const end = Math.min(changed.length, Math.max(a, b));
    if (start > end) continue;
    addRange(
      start,
      end,
      String(candidate.title ?? "").trim() || "Implementation step",
      String(candidate.description ?? "").trim()
    );
  }

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
    addRange(index, end, "Remaining changes", "Changes the model did not include in another step.");
    index = end;
  }

  return chunks;
}

export function replayStepMap(chunks: ReplayChunk[]): Map<number, number> {
  const map = new Map<number, number>();
  chunks.forEach((chunk, step) => {
    for (let index = chunk.start; index <= chunk.end; index++) map.set(index, step);
  });
  return map;
}

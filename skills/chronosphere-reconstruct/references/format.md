# Inputs and portable output

The helper has no imports from the Chronosphere application. Copy the whole `chronosphere-reconstruct` folder to another agent's skills directory, or supply its instructions and helper to an agent with file execution tools.

## Source manifest

`prepare` writes this structure; agents using connectors can construct it directly:

```json
{
  "title": "PR #1234: Handle empty names",
  "repository": {"name": "owner/repo", "head": "FULL_HEAD_SHA", "branch": null},
  "base": "FULL_COMPARISON_BASE_SHA",
  "targetBase": "FULL_TARGET_BASE_SHA",
  "pullRequest": "https://github.com/owner/repo/pull/1234",
  "files": {
    "src/name.py": {"before": "def name(s):\n    return s.strip()\n", "after": "def name(s):\n    return (s or '').strip()\n"},
    "tests/test_name.py": {"before": null, "after": "def test_empty():\n    assert name(None) == ''\n"}
  },
  "omitted": []
}
```

Replace the SHA placeholders with full hexadecimal commit IDs (40 or 64 characters). `base` is the comparison merge base; `targetBase` is optional provenance for the target branch tip. `pullRequest` is optional. `repository.branch` is a branch name or null. Include only changed files; every entry requires both `before` and `after`. Use null for absence and an empty string for an existing empty file. Preserve Unicode, BOMs, CRLF, and missing final newlines exactly. Full snapshots, not unified patches, are required. A rename is two entries: the old path deleted and the new path added. Paths use `/`, are relative to the repository, and cannot contain backslashes, empty/dot/dot-dot components, or control characters.

Each omitted item is `{"path":"image.png","reason":"Binary file"}`. Disclose missing/unsupported files rather than representing them as deletions. Omit both endpoint snapshots if either cannot be captured faithfully. Record mode-only changes as omissions; a mode change accompanying a text change may be listed while retaining the text. Exclude `.chronosphere` artifacts and credential files, even if building the manifest manually. If a pathname itself cannot be represented by the replay format, stop and disclose it instead of changing its spelling.

## Step plan

```json
{
  "steps": [
    {
      "title": "Handle missing names",
      "reason": "Missing values normalize to an empty name before trimming.",
      "files": ["src/name.py"]
    },
    {
      "title": "Cover missing input",
      "reason": "The regression test asserts the empty result for a missing name.",
      "files": ["tests/test_name.py"]
    }
  ]
}
```

`files` advances those paths to their final `after` values. Optional `snapshots` maps paths to complete intermediate content strings or null. A path cannot occur in both fields of the same step. Intermediate snapshots allow a file to participate in multiple steps; the final state must match the manifest exactly. Do not leave files out of the plan, repeat no-op replacements, or introduce paths absent from the manifest. Every step needs a nonempty title and reason, and must actually change at least one file.

## Chronosphere recording v1

Output is UTF-8 JSONL: one JSON object per physical line, no fences, blank lines, or enclosing array. Escape newlines inside JSON strings using a JSON serializer. Include a final newline.

The first object has:

- `type: "session"`, `format: "chronosphere.recording"`, `version: 1`, `capture: "checkpoints"` (the v1 transport value, even for reconstruction).
- A unique `id`, generation-time ISO `createdAt`, and `title` prefixed with `Reconstructed:`.
- `repository: {name, head, branch}`. For the baseline, `head` is the comparison base SHA; the original PR head is retained in reconstruction metadata.
- `scope`: all included changed paths; it must not be empty.
- `baseline`: a map of existing before-files to `{content, sha256}`; absent files are not keys.
- `omitted`: the omissions list.
- Extra `reconstruction` metadata: `{base, head, targetBase, pullRequest, notice}`. Older v1 readers ignore this metadata. Keep the reconstruction notice in the visible title and first event reason too.

Each step is an object with `type: "change"`, unique `id`, contiguous `sequence` starting at 1, generation-time ISO `recordedAt`, `title`, `reason`, `changes`, and `omitted: []`. Each change is `{path, before, after}`, where each endpoint is `{content, sha256}` or null. Hash the exact UTF-8 bytes with SHA-256 and encode as 64 lowercase hexadecimal characters. `before` must equal the replay state immediately before the step. Each path occurs at most once per step, and its endpoints must differ.

Finish with one event of `type: "finish"`, the next sequence number, unique ID, timestamp, title, reason, `changes: []`, and `omitted: []`. Its reason states that included endpoint files match the pinned head, names the head, and reports omissions. Never emit synthetic `command` events. Nothing follows the finish event.

Maximum import sizes: 256 KiB of UTF-8 per file snapshot, 20 MiB for the entire serialized JSONL, and 2,000 events including finish. Text metadata is nonblank and at most 8,000 UTF-16 code units; paths at most 4,096. The helper also bounds source/plan inputs to 64 MiB and source endpoint snapshots to 8 MiB combined. If limits are exceeded, disclose the coverage constraint; do not silently truncate. Fewer intermediate snapshots can reduce output size without dropping PR changes.

When reimplementing the helper, validate every hash, sequence, unique ID, path, size limit, and patch precondition, replay all events, and compare the entire final included state to the authoritative head snapshots. Output-size and hash validation alone do not establish complete PR coverage: independently verify that the manifest accounts for every changed file.

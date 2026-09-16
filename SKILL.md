---
name: chronosphere-record
description: Record a coding task as ordered local Chronosphere checkpoints with concise change explanations and command results. Use when the user wants to record or replay the development process, or when continuing an active recording session.
---

# Record a coding session

Use the recorder beside this root-level skill: `scripts/record.mjs`. Resolve `<chronosphere>` to the directory containing this `SKILL.md`. It requires Node 22.13+ and a Git working copy. For the complete format and limits, read the repository's `README.md` section “Local recording experiment” when needed.

1. Before the first edit, run `node --experimental-strip-types <chronosphere>/scripts/record.mjs start --repo <working-copy> --title 'Task title'`. Include the type-stripping flag in subsequent recorder invocations too, for Node 22 compatibility. Use repeated `--include <relative-file-or-directory>` when the task's scope is known. Retain the absolute `.jsonl` session path printed by the recorder in task context. When resuming, use `inspect --session <path>` to check the existing session; do not create a replacement history.
2. After each coherent edit/tool operation, and before starting the next edit or check, run `checkpoint --session <path> --title 'What changed' --reason 'Why this change helps the task'`. The recorder reads actual file content. Do not reconstruct patches or compute hashes yourself. An edit that is later revised or reverted gets another checkpoint; never rewrite earlier events.
3. Run relevant checks through `run --session <path> --title 'Check name' --reason 'What this checks' -- <command> <args>`. It records the result, bounded output, and resulting file changes even if the command fails. It returns the command's exit status. Capture pending edits first if the recorder refuses to run. Use ordinary commands needed for the task; recording does not authorize extra side effects.
4. End with `finish --session <path> --title 'Outcome' --reason 'What was completed and any remaining limitations'`. Keep the session path in the handoff. For local inspection, import it through Chronosphere's `/recordings` view; for PR review, use the sharing workflow below.

Reasons should be brief explanations of observable intent or evidence, such as “The failing empty-input test showed that this branch returned undefined.” Do not claim to expose private reasoning. If changes accumulated without checkpoints, say that the checkpoint combines those edits; do not invent their order. Preserve user edits and distinguish them from your own when known. Do not imply that a recorded passing test proves unrelated behavior.

## Share a replay with a PR

When the user requests a PR with its recording, export the finished session before committing:

```sh
node --experimental-strip-types <chronosphere>/scripts/record.mjs export --session <session.jsonl>
git add .chronosphere/replay.jsonl
```

The conventional PR artifact is **`.chronosphere/replay.jsonl` at the target repository root**. The exporter uses the session's local locator to find that repository, validates the recording, and replaces any previous export. Commit this file with the code changes. Chronosphere discovers it at the selected PR's head commit, including forked PRs. Do not rename or relocate it when relying on automatic discovery. The recorder excludes `.chronosphere` from capture, so the export does not record itself.

Keep raw sessions and their `.local.json` companions local. In the target repository's root `.gitignore`, use these rules (replace a blanket `.chronosphere/` rule, which would also hide the export):

```gitignore
/.chronosphere/*
!/.chronosphere/replay.jsonl
```

Alternatively, open the associated PR in Chronosphere and choose **Attach recording** to load the session's `.jsonl` manually. Attachments last for the current browser tab and need reattaching after refresh; review drafts persist. The PR workspace supports inline comments on verified PR lines and review-summary notes on historical lines.

Recordings contain source text and command output. Sharing a recording must be within the user's request; ordinary local capture does not authorize uploading or committing it. Inspect the artifact before sharing and report any omissions or capture gaps. If the session was already finished before later edits, preserve it and describe the coverage gap; do not fabricate or rewrite history. The `.local.json` companion is only a working-copy locator and must not be committed.

The recorder observes checkpoints, not every intermediate write. It skips unsupported/oversized files and lists omissions; report material gaps. One session should have one writer and one working copy. Do not attribute concurrent edits automatically. If a lock or capture error occurs, inspect it, preserve existing records, and disclose the gap rather than fabricating a successful capture. Only remove a stale lock after verifying no recorder is still using that session. A finished session cannot be appended to.

Pass explanations as safely quoted arguments. For shell-sensitive or multiline text, invoke the recorder through a process API with an argument array rather than interpolating text into a shell command.

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

For a recorded task associated with a PR, offer a **secret gist** as the sharing option. Keep the committed-file and manual-attachment options available if the user declines. A secret gist is unlisted, not private: anyone with its URL can read it, even when the PR itself is private.

### Optional secret gist

1. Finish the session and export a validated copy to a temporary directory, named exactly `replay.json`, using `export --compress --session <session.jsonl> --out <temporary-directory>/replay.json`. Inspect its source/command output and report capture gaps. The exporter automatically gzip-compresses and Base64-encodes the JSONL in a versioned JSON envelope. The uploaded envelope must be at most 10 MB, and the expanded recording at most 20 MB. If compression still exceeds 10 MB, offer a plain committed replay or manual attachment. Keep this temporary export and the raw log out of the commit.
2. Once the file is ready, ask: **“Upload this replay to a secret GitHub gist and add its link to PR #<number>? Anyone with the link can read its source snapshots and command output.”** Identify the file, compressed upload size, and expanded size. Wait for an explicit yes; no response or a request to create a PR is not consent to upload the replay. Reuse explicit authorization already given for this particular upload. If declined, keep the log local and offer the alternatives below without automatically sharing it.
3. After approval, use authenticated GitHub CLI (`gh`) to create the gist: `gh gist create <temporary-directory>/replay.json --desc 'Chronosphere replay'`. Gists are secret by default; never pass `--public`. If credentials lack gist permission, report it and let the user authorize the required access; do not broaden permissions automatically. Upload only the exported compressed replay, never the `.local.json` companion.
4. Read the new gist through `gh api gists/<gist-id>`. Verify `public` is `false` and it contains `replay.json`. Retain the returned gist URL immediately. Read `history[0].version` and append that revision to the gist URL to pin the recording. Verify the raw file at that revision matches the exported compressed bytes before linking it. Compression is not encryption; the same source and command output remain readable after decoding.
5. Read the latest PR description. Preserve its content and append a blank line followed by exactly `chronosphere-replay: <gist-url>` as the final line, outside code fences. Use the revision-pinned URL from step 4. Update with `gh pr edit <number> --repo <owner/repo> --body-file <temporary-body-file>` (or a structured API body); do not interpolate multiline PR text into shell commands. If creating the requested PR now, include the tag at the end of its body instead.
6. Keep exactly one active tag. If the PR already has one, inspect it before creating another gist: reuse it if it already holds this recording; otherwise explain the replacement in the approval question. On an uncertain create result, inspect the user's recent gists before retrying. If upload succeeds but the PR update fails, report the gist URL and retry only the PR update; do not create duplicate gists or silently delete an uploaded one.
7. Read the PR description back to confirm its final tag, and return the PR and gist links. Chronosphere loads the tagged gist before looking for a committed replay. The app accepts either compressed `replay.json` or legacy plain `replay.jsonl`; include only one of those names in a gist. An unavailable or malformed tagged gist is an error, not a reason to silently load another recording.

For example, the final PR-description line has this form:

```text
chronosphere-replay: https://gist.github.com/<owner>/<gist-id>/<revision>
```

Do not run these posting steps merely because this skill describes them. The user's per-recording sharing choice controls them. Do not claim a gist was created or linked unless those operations succeeded.

### Commit the replay instead

When the user chooses to commit the recording, export the finished session before committing:

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

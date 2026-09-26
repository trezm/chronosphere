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

For a recorded task associated with a PR, offer a **PR comment with the replay attached** as the sharing option. Keep the committed-file and manual-attachment options available if the user declines. Anyone who can read the PR can download the attachment; on a public repository that is everyone.

GitHub has no API for comment attachments, so `gh` cannot upload the file. The upload goes through GitHub's web comment box in a browser where the user is signed in to GitHub (for example Claude in Chrome with its file-upload tool). If no such browser is available, hand the file to the user to attach themselves (step 6).

### Optional PR comment attachment

1. Finish the session and export a validated copy to a temporary directory, named exactly `replay.json`, using `export --compress --session <session.jsonl> --out <temporary-directory>/replay.json`. Inspect its source/command output and report capture gaps. The exporter gzip-compresses and Base64-encodes the JSONL in a versioned JSON envelope. The attachment must be at most 10 MB, and the expanded recording at most 20 MB. If compression still exceeds 10 MB, offer a plain committed replay or manual attachment. Keep this temporary export and the raw log out of the commit.
2. Once the file is ready, ask: **“Post a comment on PR #<number> with this replay attached? Anyone who can read the PR can download its source snapshots and command output.”** Identify the file, compressed size, expanded size, and whether the repository is public. For a private repository, add that Chronosphere may be unable to load the attachment, because GitHub may only serve private attachments to a signed-in browser; committing the replay is the reliable option there. Wait for an explicit yes; no response or a request to create a PR is not consent to post the replay. Reuse explicit authorization already given for this particular comment. If declined, keep the log local and offer the alternatives below without automatically sharing it.
3. After approval, open the PR's conversation page in the signed-in browser. Upload `<temporary-directory>/replay.json` through the new-comment box's file input (or its “Paste, drop, or click to add files” control). Wait until the uploading placeholder is replaced by a link of the form `[replay.json](https://github.com/user-attachments/files/<id>/replay.json)`. Read that URL from the comment box; do not guess or construct it. If the upload is rejected or never completes, stop and report it; do not fall back to a gist or another host.
4. Make the comment body a short note, the inserted attachment link, a blank line, and exactly `chronosphere-replay: <attachment-url>` as its own line, outside code fences. Submit the comment. Upload only the exported compressed replay, never the raw session or its `.local.json` companion.
5. Verify with `gh api repos/<owner>/<repo>/issues/<number>/comments --paginate`. Confirm the new comment is authored by the user and contains exactly one `chronosphere-replay:` line with the attachment URL. For a public repository, also download it with `curl -fsSL <attachment-url>` and confirm the bytes match the exported file. Compression is not encryption; the same source and command output remain readable after decoding.
6. Without a usable browser, give the user the exported file path and the exact tag line. Ask them to drag the file into a new PR comment, then replace the placeholder with the URL GitHub inserts. Verify the posted comment as in step 5 once they say it is done.
7. Chronosphere uses the newest PR comment with a `chronosphere-replay:` tag written by the PR author or a repository owner, member, or collaborator. Re-sharing a recording means posting a new comment; do not edit or delete earlier replay comments without asking. On an uncertain submit result, check the PR's comments before retrying so you do not post a duplicate. An unavailable or malformed tagged attachment is an error in the app, not a reason to silently load another recording. Return the PR and comment links.

For example, the replay comment ends with this line:

```text
chronosphere-replay: https://github.com/user-attachments/files/<id>/replay.json
```

Do not run these posting steps merely because this skill describes them. The user's per-recording sharing choice controls them. Do not claim a comment was posted or a file attached unless those operations succeeded.

Older PRs may link a secret gist from the last line of the PR description. Chronosphere still loads those when no replay comment exists; do not create new gists for sharing.

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

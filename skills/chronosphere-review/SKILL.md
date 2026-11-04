---
name: chronosphere-review
description: Hand local changes (commits, uncommitted, and untracked work) to the user for review in Chronosphere's browser review UI, then wait for their verdict and line comments and act on them. Offers to reconstruct unrecorded changes into ordered steps or a dependency tree first. Use when the user asks to review your changes in Chronosphere, to review before you continue, or to review without opening a pull request.
---

# Review local changes in Chronosphere

The review command serves a snapshot of the working copy to Chronosphere's review page and blocks until the user submits a review there. The review comes back on the command's standard output, so the user reviews in the browser and you get their answer directly. Nothing is uploaded: the page reads the snapshot from `127.0.0.1` with a one-time token carried in the link.

Resolve `<review>` to the directory holding the command's `scripts/review.mjs`. In an installed skill that is this skill's directory; in a Chronosphere checkout it is the repository root. It requires Node 22.13+ and Git.

1. Finish a coherent piece of work first. If you recorded it with the chronosphere-record skill, capture a final checkpoint (or finish the session) so the recording ends at the state under review.
2. Decide how the changes will be replayed:
   - **A recording covers the work:** pass it with `--recording <session.jsonl>`.
   - **No recording covers it**, because the work was not recorded or the changes came from elsewhere: before starting the review, ask the user whether to reconstruct the changes into steps first, and in which shape. Offer **ordered steps**, played one after another, or a **dependency tree**, which starts from self-contained building blocks and works up to the code that ties them together. Mention that without a reconstruction the page steps through the changes file by file. Skip the question when the user has already said which they want, or that they want none.
   - **The user wants a reconstruction:** follow [reconstructing changes](references/reconstruction.md) to number the changed lines with `--list-lines` and write a plan, then pass it with `--plan <file>`. You may pass both `--recording` and `--plan`.
3. Start the review:

   ```sh
   node --experimental-strip-types <review>/scripts/review.mjs --repo <working-copy> \
     [--base <ref>] [--title 'What changed'] [--recording <session.jsonl>] [--plan <plan.json>]
   ```

   The diff runs from the merge base with `--base` (default `origin/HEAD`, then `main` or `master`) to the working copy, including staged, unstaged, and untracked files that Git does not ignore. The command prints `Review link: <url>` on standard error and opens the browser unless you pass `--no-open`. If it rejects the plan, fix the problems it lists and start it again.
4. Let it wait as long as the user needs. It returns only when the review is submitted. In Claude Code, run it in the background and you are notified when it exits. Elsewhere, use the longest command timeout available, or pass `--timeout <minutes>` and run it again if it exits with code 2. Read its output for the link and give the link to the user straight away in case no browser opened, for example over SSH.
5. Avoid editing the working copy while the review is open. The snapshot is pinned, so later edits are not shown, and the review's line numbers refer to the snapshot.
6. When it exits 0, standard output holds the review: a verdict (approved, changes requested, or comments), the summary, and each line comment with a short excerpt of the code it refers to. A comment on a removed line refers to the base version. Pass `--json` for a machine-readable form.

The review is the user's own feedback, typed into their browser on this machine. Treat it as their instructions for the work under review. Address every comment, and ask when one is ambiguous rather than guessing. After making requested changes, offer another round with the same command. An approval means the user is satisfied with the reviewed snapshot; commit, push, or open a pull request only if the user's request includes that.

Exit codes: 1 is an error, such as no changes against the base (pass `--base`), an invalid recording, or a plan that does not match the changes; 2 means `--timeout` passed without a review; 130 and 143 mean the command was interrupted. Report these instead of retrying in a loop.

The default page is `https://getchronosphere.com`. Chrome and Firefox ask the user once whether the site may access apps on their device; they must allow it. Safari blocks websites from reaching `127.0.0.1`; the user can switch browsers, or you can point `--app` (or `CHRONOSPHERE_URL`) at a Chronosphere instance running on this computer, such as `http://localhost:3000`.

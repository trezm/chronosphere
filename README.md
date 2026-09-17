# Chronosphere

Chronosphere reconstructs a pull request into a plausible, step-by-step implementation story. Reviewers can scrub through the replay, stage inline comments at any step, submit a single GitHub review, and merge when the pull request is ready.

PR replay can use an AI reconstruction or recorded workspace checkpoints with explanations and command results. Both use the same timeline, diff views, and GitHub review sidebar; the source is labelled explicitly.

## What is included

- Required GitHub OAuth with PKCE
- OpenRouter OAuth with PKCE for AI reconstruction and AI review (optional for recorded playback)
- Repository picker and searchable open pull request list
- Involvement filters for authored, assigned, and review-requested PRs
- Author, assignee, and requested-reviewer context
- LLM-generated replay timeline with playable/scrubbable diff states
- Steps that span several files, such as a trait and its implementation, shown as file tabs above the diff
- Model-selected high-impact markers for the most consequential replay steps
- On-demand two-stage AI review: a scout triages the diff, then a reviewer returns high-confidence findings
- AI findings that can be staged individually or in bulk as editable GitHub review comments
- Pending inline review comments carried across replay steps
- Durable per-user PR state for replay position, AI review results, and staged GitHub review drafts
- GitHub comment, approval, and request-changes reviews
- Merge, squash, and rebase actions pinned to the reviewed head SHA
- Mergeability and conflict status
- Railway build, start, and health-check configuration
- Local JSONL recorder and browser-only recording playback at `/recordings`
- PR-associated recordings from `.chronosphere/replay.jsonl` or a manual attachment, with inline review comments and historical-step notes

## Review a recording with a PR

Open a pull request in Chronosphere. The replay source bar lets you switch between **AI synopsis** and **Recording**, or **Attach recording** from a local `.jsonl` file. Recorded steps use the same timeline, file tabs, syntax-highlighted diffs, pending comments, review submission, and merge controls as reconstructed steps. GitHub sign-in is required; OpenRouter is only needed for AI features.

To share the recording with the PR, finish the session and export it:

```sh
npm run record -- export --session /absolute/path/to/session.jsonl
git add .chronosphere/replay.jsonl
```

Commit the exported file with your code changes. Chronosphere looks for exactly `.chronosphere/replay.jsonl` at the selected PR's head commit, including forked PRs. The exporter replaces that artifact when run again and copies only the validated, finished JSONL, never the local working-copy locator. This repository's ignore rules keep raw sessions private while allowing the exported artifact. In other repositories using a blanket `.chronosphere/` ignore, use `/.chronosphere/*` plus `!/.chronosphere/replay.jsonl` instead. The recorder excludes `.chronosphere` from capture, and the log is excluded from code reconstruction and AI review input.

A manually attached file is associated with the selected PR/head for the current tab. Its source contents stay in browser memory; reattach after refreshing. The timeline metadata, current step, inline comments, and review summary use the existing per-user PR draft storage. A committed recording reloads from GitHub. Switching sources preserves pending comments and the review summary.

Inline comments are anchored only when the recorded whole-file version matches the verified PR base/head file and the line is present in GitHub's diff. Comments on earlier or discarded versions go into the review summary with their file, line, event, and step instead of being attached to an incorrect GitHub line. **Full PR** always shows the current authoritative diff. Review submission rejects a PR head that changed after opening it.

## Local recording experiment

Run `npm run record:demo`, then open `/recordings` and choose the printed `.jsonl` path. The demo runs a real failing test in a temporary repository, fixes the implementation, reruns the test, and creates then deletes a scratch file. The viewer preserves every checkpoint even though the scratch file is absent from the final workspace. This route needs no GitHub or OpenRouter connection.

To record your own work (Node 22.13+):

```sh
# Start before editing. Repeat --include for selected files/directories;
# omit it to capture the repository's eligible text files.
npm run record -- start --title 'Add request validation' --include lib --include tests

# Replace SESSION.jsonl with the absolute path printed by start.
npm run record -- checkpoint --session SESSION.jsonl \
  --title 'Validate before writing' \
  --reason 'Reject invalid input before it can create partial records.'

# Run checks through the recorder; its exit status matches the command.
npm run record -- run --session SESSION.jsonl \
  --title 'Check validation behavior' --reason 'Verify the accepted and rejected inputs.' \
  -- npm test

npm run record -- finish --session SESSION.jsonl \
  --title 'Finish validation work' --reason 'The implementation and checks are complete.'
```

Use the [`chronosphere-record` skill](SKILL.md) to have a coding agent follow this workflow. The recorder can target another Git working copy with `node --experimental-strip-types /path/to/chronosphere/scripts/record.mjs start --repo /path/to/repo ...`. Subsequent commands find that working copy through the session's local companion file. The type-stripping flag enables the shared TypeScript format validator on older Node 22 releases; `npm run record` includes it automatically.

**Where the record lives.** Sessions default to `.chronosphere/recordings/<id>.jsonl`, ignored by this repository. When targeting another repository, add `.chronosphere/` to its ignore rules or use `--out` with a location outside that repository. Files are created with owner-only permissions. The `.jsonl` is a self-contained replay artifact; its `.local.json` companion contains an absolute working-copy path and is only needed to continue recording. Import reads the artifact into browser memory. Refreshing the tab clears it. PR association is described above; the standalone viewer does not store or upload source snapshots.

**What it captures.** The first line contains the current text snapshot (including existing uncommitted changes), repository name/branch/base commit, and selected scope. Subsequent lines contain sequence numbers, stable event IDs, timestamps, titles, explanations, and reversible file replacements with SHA-256 hashes. Command events include arguments, exit status or signal, and up to 32,000 characters of combined output. Capture a checkpoint after each coherent edit and before running a check; `run` refuses pending unrecorded changes so they cannot be attributed to the command. Renames appear as deletion plus addition. `finish` captures remaining edits and closes the session.

**Limits and interpretation.** These are explicitly requested checkpoints, not automatic observation of every edit or the model's internal reasoning. Changes between two checkpoints are combined. Concurrent human edits cannot be attributed automatically. One session has a single writer, protected by an exclusive lock; separate agents should use separate worktrees and recordings. A crash can leave a lock or incomplete line: the recorder refuses to append until the problem is resolved, rather than silently dropping history. Hashes and patch preconditions detect inconsistencies, but do not authenticate the author or prove a complete history.

The recorder selects Git-tracked and non-ignored untracked UTF-8 text files. It skips common credential names, symlinks, binary files, and files larger than 256 KB; the log lists omissions within the selected scope. Git-ignored untracked files are not read. A previously recorded file that becomes ignored or unreadable stays at its last captured text and is marked omitted, rather than being misrepresented as deleted. Initial/current readable snapshots are limited to 8 MB and 5,000 files; sessions to 20 MB and 2,000 events. These are bounded experimental limits. Source text and command output may contain sensitive material even with filename exclusions; inspect the artifact before choosing to share it.

The viewer checks content hashes, contiguous event order, unique IDs, and each patch's prior state before loading. It supports playback, arbitrary scrubbing, before/after files, complete captured workspace states, and command evidence. For GitHub comments, use the PR workspace and attach the same recording; the standalone viewer remains available for local inspection.

## Local setup

Requirements: Node.js 22.13 or newer and a GitHub OAuth App.

1. Copy `.env.example` to `.env.local`.
2. Create a GitHub OAuth App with homepage `http://localhost:3000` and callback `http://localhost:3000/api/auth/github/callback`.
3. Fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a random `SESSION_SECRET`.
4. Run `npm install`, then `npm run dev`.

OpenRouter does not require a client secret. Chronosphere creates a user-controlled OpenRouter key through the provider's PKCE flow and keeps it in the encrypted HTTP-only session cookie.

## Durable PR state

Per-user PR state uses Cloudflare D1 when a `DB` binding is present and a local SQLite file otherwise, so the store works on Cloudflare Workers and on plain Node. On the Node path the generated migrations in `drizzle/` are applied once per process, resolved from the working directory the server was started in.

The database file is chosen in this order:

1. `SQLITE_PATH`, if set, is used as-is.
2. `RAILWAY_VOLUME_MOUNT_PATH`, if set, gives `<mount>/chronosphere.sqlite`.
3. Otherwise `.data/chronosphere.sqlite` relative to the working directory.

Missing parent directories are created on startup. Run `npm run db:generate` after changing `db/schema.ts`.

## Railway

Create a Railway service from this repository and set:

- `APP_URL` to the final Railway public URL
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`
- optionally `OPENROUTER_MODEL`, `OPENROUTER_SCOUT_MODEL`, and `OPENROUTER_REVIEWER_MODEL`

Attach a Railway volume so PR state survives deploys and restarts. Railway sets `RAILWAY_VOLUME_MOUNT_PATH`, which Chronosphere picks up automatically; set `SQLITE_PATH` only to override that location. Without a volume the SQLite file lives on the ephemeral container filesystem and is lost on every deploy.

Update the GitHub OAuth App homepage and callback to the same public origin. Railway reads `railway.json`, lets Railpack install dependencies, runs `npm run build`, starts on Railway's `$PORT`, and checks `/api/auth/session` for health.

## Security notes

Provider credentials are encrypted with AES-GCM using `SESSION_SECRET` and stored only in secure, HTTP-only, same-site cookies. GitHub OAuth uses `state` and PKCE. OpenRouter OAuth uses PKCE. Opening the app checks the stored GitHub token: one that is expiring is refreshed with its refresh token (when the OAuth App issues expiring tokens), the rest are validated against GitHub, and a token GitHub rejects returns the browser to the connect page. A request that meets an expired token mid-session refreshes and retries once before doing the same. Replay progress, AI results, and in-progress review text are stored in D1 or in the local SQLite database, scoped to the signed-in GitHub user and pull request, and invalidated when the head commit changes. Browser storage is used only as a temporary fallback and migration path for drafts created before durable storage was added. Merge calls include the pull request head SHA seen by the reviewer, so GitHub rejects the action if the branch changed in the meantime.

For a larger public deployment, replace cookie-held provider credentials with a server-side session store and add organization-specific authorization and audit retention.

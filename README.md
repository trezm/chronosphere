# Chronosphere

Chronosphere reconstructs a pull request into a plausible, step-by-step implementation story. Reviewers can scrub through the replay, stage inline comments at any step, submit a single GitHub review, and merge when the pull request is ready.

The replay is explicitly a model-generated reconstruction, not recorded history.

## What is included

- Required GitHub OAuth with PKCE
- Required OpenRouter OAuth with PKCE
- Repository picker and searchable open pull request list
- Involvement filters for authored, assigned, and review-requested PRs
- Author, assignee, and requested-reviewer context
- LLM-generated replay timeline with playable/scrubbable diff states
- Model-selected high-impact markers for the most consequential replay steps
- On-demand two-stage AI review: a scout triages the diff, then a reviewer returns high-confidence findings
- AI findings that can be staged individually or in bulk as editable GitHub review comments
- Pending inline review comments carried across replay steps
- Durable per-user PR state for replay position, AI review results, and staged GitHub review drafts
- GitHub comment, approval, and request-changes reviews
- Merge, squash, and rebase actions pinned to the reviewed head SHA
- Mergeability and conflict status
- Railway build, start, and health-check configuration

## Local setup

Requirements: Node.js 22.13 or newer and a GitHub OAuth App.

1. Copy `.env.example` to `.env.local`.
2. Create a GitHub OAuth App with homepage `http://localhost:3000` and callback `http://localhost:3000/api/auth/github/callback`.
3. Fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a random `SESSION_SECRET`.
4. Run `npm install`, then `npm run dev`.

OpenRouter does not require a client secret. Chronosphere creates a user-controlled OpenRouter key through the provider's PKCE flow and keeps it in the encrypted HTTP-only session cookie.

## Railway

Create a Railway service from this repository and set:

- `APP_URL` to the final Railway public URL
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`
- optionally `OPENROUTER_MODEL`, `OPENROUTER_SCOUT_MODEL`, and `OPENROUTER_REVIEWER_MODEL`

Update the GitHub OAuth App homepage and callback to the same public origin. Railway reads `railway.json`, lets Railpack install dependencies, runs `npm run build`, starts on Railway's `$PORT`, and checks `/api/auth/session` for health.

## Security notes

Provider credentials are encrypted with AES-GCM using `SESSION_SECRET` and stored only in secure, HTTP-only, same-site cookies. GitHub OAuth uses `state` and PKCE. OpenRouter OAuth uses PKCE. Replay progress, AI results, and in-progress review text are stored in D1, scoped to the signed-in GitHub user and pull request, and invalidated when the head commit changes. Browser storage is used only as a temporary fallback and migration path for drafts created before durable storage was added. Merge calls include the pull request head SHA seen by the reviewer, so GitHub rejects the action if the branch changed in the meantime.

For a larger public deployment, replace cookie-held provider credentials with a server-side session store and add organization-specific authorization and audit retention.

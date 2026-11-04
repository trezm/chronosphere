# Chronosphere skills

Create portable code replays with your agent, and review its local work in Chronosphere. These skills run locally; the recording and reconstruction skills produce files that Chronosphere can play, without installing or connecting to the Chronosphere application.

| Skill | Use it for | Requirements |
| --- | --- | --- |
| [chronosphere-record](skills/chronosphere-record/SKILL.md) | Capture actual edits, explanations, and command results while working | Node.js 22.13+ and Git |
| [chronosphere-reconstruct](skills/chronosphere-reconstruct/SKILL.md) | Turn an existing pull request into an inferred implementation sequence | Python 3.9+ and PR file access; Git optional |
| [chronosphere-review](skills/chronosphere-review/SKILL.md) | Review the agent's local changes in Chronosphere, as recorded or reconstructed steps or a dependency tree, and send the review straight back to it | Node.js 22.13+, Git, and Chrome or Firefox |

## Install

Use the [skills CLI](https://github.com/vercel-labs/skills) to select your agent and install both skills:

```sh
npx skills add trezm/chronosphere-skills
```

Or install one:

```sh
npx skills add trezm/chronosphere-skills --skill chronosphere-reconstruct
npx skills add trezm/chronosphere-skills --skill chronosphere-record
npx skills add trezm/chronosphere-skills --skill chronosphere-review
```

You can also download individual skill ZIPs from [Releases](https://github.com/trezm/chronosphere-skills/releases/latest). Each ZIP contains a complete skill folder. Copy the folder into your agent's supported skills location, or provide its instructions and files to an agent with execution tools. Support for uploading or automatically discovering skills depends on the agent; a name alone does not install a skill.

## Ask your agent

> Use your chronosphere-record skill while implementing this change. Keep the replay local.

> Use your chronosphere-reconstruct skill to generate a replay for owner/repo PR #1234.

> Let me review your changes in Chronosphere before you continue.

Recording observes explicit checkpoints, including revisions and failed checks. Reconstruction explains verified endpoint changes in a plausible order; it does not recover the author's actual development history or invent test results. Both output Chronosphere v1 JSONL. Open the file through **Attach recording** in a PR workspace or the app's `/recordings` page. The current importer labels imported files as Recording; reconstructed files identify themselves in their title and opening explanation.

No model API key or Chronosphere account is needed to generate files. Your agent supplies the reasoning and repository access. The helper scripts use standard libraries only; no package installation is required to run them. GitHub CLI and a browser signed in to GitHub are optional, for the recording skill's user-approved PR-comment sharing workflow.

The review skill runs a command that waits on `127.0.0.1` while you review the agent's changes at getchronosphere.com/local. The page reads the changes from your machine and posts your review back to the agent; nothing is uploaded. Chrome and Firefox ask once to allow the site to reach apps on your device. Safari blocks it.

Replays include source snapshots and may include command output. Keep them local until you choose to share them. Anyone who can read a PR can download a replay attached to its comments. Raw recording sessions and their `.local.json` locator files should stay out of commits.

## Development

Run the portable compatibility tests with Node.js 22.13+, Python 3.9+, and Git:

```sh
npm test
```

No npm dependencies are needed. The tests exercise recording, reconstruction, local review, compression, import validation, and endpoint fidelity in temporary repositories. CI runs them on Node 22 and 24.

This repository is a curated distribution of the skills and their required helpers. Versioned releases include one ZIP per skill and SHA-256 checksums. The application itself is maintained separately.

## License

MIT. See [LICENSE](LICENSE).

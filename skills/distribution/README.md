# Chronosphere skills

Create portable code replays with your agent. These skills run locally and produce files that Chronosphere can play, without installing or connecting to the Chronosphere application.

| Skill | Use it for | Requirements |
| --- | --- | --- |
| [chronosphere-record](skills/chronosphere-record/SKILL.md) | Capture actual edits, explanations, and command results while working | Node.js 22.13+ and Git |
| [chronosphere-reconstruct](skills/chronosphere-reconstruct/SKILL.md) | Turn an existing pull request into an inferred implementation sequence | Python 3.9+ and PR file access; Git optional |

## Install

Use the [skills CLI](https://github.com/vercel-labs/skills) to select your agent and install both skills:

```sh
npx skills add trezm/chronosphere-skills
```

Or install one:

```sh
npx skills add trezm/chronosphere-skills --skill chronosphere-reconstruct
npx skills add trezm/chronosphere-skills --skill chronosphere-record
```

You can also download individual skill ZIPs from [Releases](https://github.com/trezm/chronosphere-skills/releases/latest). Each ZIP contains a complete skill folder. Copy the folder into your agent's supported skills location, or provide its instructions and files to an agent with execution tools. Support for uploading or automatically discovering skills depends on the agent; a name alone does not install a skill.

## Ask your agent

> Use your chronosphere-record skill while implementing this change. Keep the replay local.

> Use your chronosphere-reconstruct skill to generate a replay for owner/repo PR #1234.

Recording observes explicit checkpoints, including revisions and failed checks. Reconstruction explains verified endpoint changes in a plausible order; it does not recover the author's actual development history or invent test results. Both output Chronosphere v1 JSONL. Open the file through **Attach recording** in a PR workspace or the app's `/recordings` page. The current importer labels imported files as Recording; reconstructed files identify themselves in their title and opening explanation.

No model API key or Chronosphere account is needed to generate files. Your agent supplies the reasoning and repository access. The helper scripts use standard libraries only; no package installation is required to run them. GitHub CLI and a browser signed in to GitHub are optional, for the recording skill's user-approved PR-comment sharing workflow.

Replays include source snapshots and may include command output. Keep them local until you choose to share them. Anyone who can read a PR can download a replay attached to its comments. Raw recording sessions and their `.local.json` locator files should stay out of commits.

## Development

Run the portable compatibility tests with Node.js 22.13+, Python 3.9+, and Git:

```sh
npm test
```

No npm dependencies are needed. The tests exercise recording, reconstruction, compression, import validation, and endpoint fidelity in temporary repositories. CI runs them on Node 22 and 24.

This repository is a curated distribution of the skills and their required helpers. Versioned releases include one ZIP per skill and SHA-256 checksums. The application itself is maintained separately.

## License

MIT. See [LICENSE](LICENSE).

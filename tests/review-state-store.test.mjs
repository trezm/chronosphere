import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const root = new URL("../", import.meta.url);

// The store reaches the database through the "@/" path alias and extensionless
// module specifiers, both of which the bundler resolves. Node needs the same
// mapping to load those modules under `node --test`.
function resolveSource(specifier, parentURL) {
  const base = specifier.startsWith("@/") ? root : parentURL;
  const target = specifier.startsWith("@/") ? specifier.slice(2) : specifier;
  if (base === undefined || (base === parentURL && !target.startsWith("."))) return null;
  for (const candidate of [`${target}.ts`, `${target}/index.ts`]) {
    const url = new URL(candidate, base);
    if (existsSync(url)) return url.href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = resolveSource(specifier, context.parentURL);
    return nextResolve(source ?? specifier, context);
  },
});

const directory = mkdtempSync(path.join(tmpdir(), "chronosphere-state-"));
const file = path.join(directory, "nested", "state.sqlite");
process.env.SQLITE_PATH = file;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

const { deletePullRequestState, loadPullRequestState, savePullRequestState } =
  await import("../lib/review-state-store.ts");
const { isPullRequestState } = await import("../lib/review-state.ts");

test.after(() => rmSync(directory, { recursive: true, force: true }));

const headSha = "0123456789012345678901234567890123456789";
const viewer = "pete";
const repository = "acme/widget";
const pullNumber = 42;

function stateAt(step) {
  return {
    headSha,
    replay: {
      model: "openai/gpt-5-mini",
      chunks: [{ file: "app.ts", start: 1, end: 2, title: "Add app", description: "Adds the app." }],
      truncated: false,
    },
    step,
    model: "openai/gpt-5-mini",
    showFullDiff: false,
  };
}

test("creates the database file and round-trips PR state", async () => {
  assert.equal(isPullRequestState(stateAt(0)), true);

  await savePullRequestState(viewer, repository, pullNumber, stateAt(0), 1);
  assert.equal(existsSync(file), true);

  const stored = await loadPullRequestState(viewer, repository, pullNumber, headSha);
  assert.deepEqual(stored, { state: stateAt(0), revision: 1 });
});

test("returns null for a pull request that has no saved state", async () => {
  assert.equal(await loadPullRequestState(viewer, repository, 999, headSha), null);
});

test("keeps the newer state when a stale revision is saved", async () => {
  await savePullRequestState(viewer, repository, pullNumber, stateAt(5), 4);
  assert.deepEqual(await loadPullRequestState(viewer, repository, pullNumber, headSha), {
    state: stateAt(5),
    revision: 4,
  });

  await savePullRequestState(viewer, repository, pullNumber, stateAt(1), 2);
  assert.deepEqual(await loadPullRequestState(viewer, repository, pullNumber, headSha), {
    state: stateAt(5),
    revision: 4,
  });

  await savePullRequestState(viewer, repository, pullNumber, stateAt(9), 4);
  assert.deepEqual(await loadPullRequestState(viewer, repository, pullNumber, headSha), {
    state: stateAt(5),
    revision: 4,
  });
});

test("advances to a higher revision", async () => {
  await savePullRequestState(viewer, repository, pullNumber, stateAt(7), 5);
  assert.deepEqual(await loadPullRequestState(viewer, repository, pullNumber, headSha), {
    state: stateAt(7),
    revision: 5,
  });
});

test("scopes state to the viewer, repository, and head SHA", async () => {
  const otherSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  assert.equal(await loadPullRequestState("someone-else", repository, pullNumber, headSha), null);
  assert.equal(await loadPullRequestState(viewer, "acme/other", pullNumber, headSha), null);
  assert.equal(await loadPullRequestState(viewer, repository, pullNumber, otherSha), null);
});

test("deletes state and leaves nothing to load", async () => {
  await deletePullRequestState(viewer, repository, pullNumber, headSha);
  assert.equal(await loadPullRequestState(viewer, repository, pullNumber, headSha), null);
});

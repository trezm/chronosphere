import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { formatReview, planReplay } from "../scripts/review.mjs";

const reviewer = resolve("scripts/review.mjs");
const APP = "http://localhost:3000";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), "chronosphere-review-test-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV });
  git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repo, "app.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Start");
  git("switch", "--quiet", "-c", "feature");
  return { repo, git };
}

/** Starts the review command and resolves once it prints its link. */
function startReview(t, repo, ...args) {
  const child = spawn(process.execPath, ["--experimental-strip-types", reviewer, "--repo", repo, "--base", "main", "--no-open", "--app", APP, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit({ code, stdout, stderr })));
  const link = new Promise((resolveLink, reject) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/Review link: (\S+)/);
      if (match) resolveLink(new URL(match[1]));
    });
    child.on("exit", () => reject(new Error(`The review command exited early:\n${stderr}`)));
  });
  return { link, exited };
}

async function connect(t, repo, ...args) {
  const { link, exited } = startReview(t, repo, ...args);
  const url = await link;
  const params = new URLSearchParams(url.hash.slice(1));
  const origin = `http://127.0.0.1:${params.get("port")}`;
  const call = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { Authorization: `Bearer ${params.get("token")}`, Origin: APP, ...init.headers } });
  return { url, origin, call, exited };
}

test("a review snapshots commits, uncommitted and untracked work without touching the index", async (t) => {
  const { repo, git } = await fixture(t);
  await writeFile(join(repo, "app.txt"), "one\nTWO\nthree\nfour\nfive\n");
  git("commit", "--quiet", "-am", "Shout two");
  await writeFile(join(repo, "app.txt"), "one\nTWO\nthree\nfour\nFIVE\n");
  await writeFile(join(repo, "new.txt"), "brand new\n");
  await writeFile(join(repo, "ignored.txt"), "secret\n");
  await mkdir(join(repo, ".chronosphere"));
  await writeFile(join(repo, ".chronosphere", "session.jsonl"), "{}\n");
  const status = git("status", "--porcelain");

  const { url, call, exited } = await connect(t, repo, "--json");
  assert.equal(url.origin, APP);
  assert.equal(url.pathname, "/local");
  const { session } = await (await call("/session")).json();
  assert.equal(session.format, "chronosphere.local-review");
  assert.equal(session.repository.branch, "feature");
  assert.equal(session.base.sha, git("rev-parse", "main").trim());
  assert.equal(session.head.commit, git("rev-parse", "HEAD").trim());
  assert.equal(session.head.uncommitted, true);
  assert.deepEqual(session.commits.map((commit) => commit.subject), ["Shout two"]);
  assert.match(session.diff, /^\+TWO$/m);
  assert.match(session.diff, /^\+FIVE$/m);
  assert.match(session.diff, /^\+\+\+ b\/new\.txt$/m);
  assert.doesNotMatch(session.diff, /ignored\.txt|\.chronosphere/);
  // The snapshot is a tree object; the real index and working tree are untouched.
  assert.equal(git("cat-file", "-t", session.head.sha).trim(), "tree");
  assert.equal(git("status", "--porcelain"), status);

  const head = await (await call(`/file?${new URLSearchParams({ ref: session.head.sha, path: "app.txt" })}`)).json();
  assert.equal(head.content, "one\nTWO\nthree\nfour\nFIVE\n");
  const base = await (await call(`/file?${new URLSearchParams({ ref: session.base.sha, path: "app.txt" })}`)).json();
  assert.equal(base.content, "one\ntwo\nthree\nfour\nfive\n");
  // Content is pinned: later edits do not change what the reviewer sees.
  await writeFile(join(repo, "app.txt"), "changed again\n");
  assert.equal((await (await call(`/file?${new URLSearchParams({ ref: session.head.sha, path: "app.txt" })}`)).json()).content, head.content);
  assert.equal((await call(`/file?${new URLSearchParams({ ref: "HEAD", path: "app.txt" })}`)).status, 400);
  assert.equal((await call(`/file?${new URLSearchParams({ ref: session.head.sha, path: "../outside" })}`)).status, 400);

  const post = (body) => call("/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ event: "COMMENT", headSha: "0".repeat(40), body: "Hi" })).status, 409);
  assert.equal((await post({ event: "COMMENT", headSha: session.head.sha })).status, 400);
  assert.equal((await post({ event: "COMMENT", headSha: session.head.sha, comments: [{ path: "app.txt", line: 0, side: "RIGHT", body: "x" }] })).status, 400);
  const accepted = await post({ event: "REQUEST_CHANGES", headSha: session.head.sha, body: "Close, but not yet.", comments: [{ path: "app.txt", line: 5, side: "RIGHT", body: "Keep this lowercase.", step: 1 }] });
  assert.equal(accepted.status, 200);

  const { code, stdout } = await exited;
  assert.equal(code, 0);
  const review = JSON.parse(stdout);
  assert.equal(review.event, "REQUEST_CHANGES");
  assert.equal(review.summary, "Close, but not yet.");
  assert.deepEqual(review.comments, [{ path: "app.txt", line: 5, side: "RIGHT", body: "Keep this lowercase.", excerpt: { startLine: 3, lines: ["three", "four", "FIVE"] } }]);
  assert.equal(review.snapshot.tree, session.head.sha);
});

test("a same-size edit made in the second after a commit is still in the snapshot", async (t) => {
  const { repo, git } = await fixture(t);
  await writeFile(join(repo, "app.txt"), "one\ntwo\nthree\nfour\nsix\n");
  git("commit", "--quiet", "-am", "Six");
  await writeFile(join(repo, "app.txt"), "one\ntwo\nthree\nfour\nSIX\n");
  // Once the clock moves past the index's second, only its preserved timestamp makes Git recheck the file.
  await new Promise((resolveWait) => setTimeout(resolveWait, 1100));
  const listed = spawnSync(process.execPath, ["--experimental-strip-types", reviewer, "--repo", repo, "--base", "main", "--list-lines"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^\[\d+\] \+ SIX$/m);
});

test("the bridge answers only its own page, with its token, on a loopback host", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, "app.txt"), "changed\n");
  const { origin, call } = await connect(t, repo);
  assert.equal((await fetch(`${origin}/session`)).status, 401);
  assert.equal((await call("/session", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call("/session", { headers: { Origin: "https://evil.example" } })).status, 403);
  const preflight = await fetch(`${origin}/review`, { method: "OPTIONS", headers: { Origin: APP, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), APP);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);
  const allowed = await call("/session");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), APP);
});

test("a bare approval is a complete review and prints as markdown", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, "app.txt"), "changed\n");
  const { call, exited } = await connect(t, repo);
  const { session } = await (await call("/session")).json();
  assert.equal(session.title, "Local changes on feature");
  assert.equal((await call("/review", { method: "POST", body: JSON.stringify({ event: "APPROVE", headSha: session.head.sha }) })).status, 200);
  const { code, stdout } = await exited;
  assert.equal(code, 0);
  assert.match(stdout, /^# Chronosphere review: approved$/m);
  assert.match(stdout, /No line comments\./);
});

test("a recording passed to the review command travels with its id", async (t) => {
  const { repo } = await fixture(t);
  const recorder = (...args) => execFileSync(process.execPath, ["--experimental-strip-types", resolve("scripts/record.mjs"), ...args], { cwd: repo, encoding: "utf8" });
  const recording = join(repo, ".chronosphere", "session.jsonl");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n.chronosphere/\n");
  recorder("start", "--out", recording, "--title", "Change app");
  await writeFile(join(repo, "app.txt"), "changed\n");
  recorder("checkpoint", "--session", recording, "--title", "Change app", "--reason", "Exercise the replay.");
  recorder("finish", "--session", recording, "--title", "Done", "--reason", "Finished.");
  const { call } = await connect(t, repo, "--recording", recording);
  const { session } = await (await call("/session")).json();
  const header = JSON.parse(session.recording.source.split("\n", 1)[0]);
  assert.equal(session.recording.id, header.id);
  assert.equal(session.recording.name, "session.jsonl");
});

test("the review command refuses an empty diff and an invalid recording", async (t) => {
  const { repo } = await fixture(t);
  const empty = spawnSync(process.execPath, ["--experimental-strip-types", reviewer, "--repo", repo, "--base", "main", "--no-open"], { encoding: "utf8" });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no changes against main/);
  await writeFile(join(repo, "app.txt"), "changed\n");
  await writeFile(join(repo, "ignored.txt"), "not a recording\n");
  const invalid = spawnSync(process.execPath, ["--experimental-strip-types", reviewer, "--repo", repo, "--base", "main", "--no-open", "--recording", join(repo, "ignored.txt")], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /recording/i);
});

test("the review command refuses changes with no lines to review", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", reviewer, "--repo", repo, "--base", "main", "--no-open"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no lines to review/);
});

test("markdown reviews quote each commented line with its context", () => {
  const session = {
    repository: { branch: "feature" },
    base: { ref: "origin/main", sha: "a".repeat(40) },
    head: { sha: "b".repeat(40), commit: "c".repeat(40), uncommitted: false },
  };
  const text = formatReview({
    event: "COMMENT",
    summary: "Looks reasonable.",
    comments: [{ path: "lib/a.ts", line: 9, side: "LEFT", body: "Why remove this?", excerpt: { startLine: 8, lines: ["before", "removed ``` fence", "after"] } }],
  }, session);
  assert.match(text, /^# Chronosphere review: comments$/m);
  assert.match(text, /Reviewed snapshot `bbbbbbbb` of `feature` \(commit `cccccccc`\) against `origin\/main` at `aaaaaaaa`/);
  assert.match(text, /^### 1\. lib\/a\.ts:9 \(removed line, base version\)$/m);
  // The fence outgrows any backticks inside the quoted code.
  assert.match(text, /^````\n {3}8 \| before\n> {2}9 \| removed ``` fence\n {2}10 \| after\n````$/m);
  assert.match(text, /^Why remove this\?$/m);
});

const PLAN_SESSION = {
  base: { ref: "main", sha: "a".repeat(40) },
  head: { sha: "b".repeat(40) },
  // Six changed lines: 1–3 in model.ts, 4–5 in service.ts, 6 in handler.ts.
  diff: [
    "diff --git a/model.ts b/model.ts", "new file mode 100644", "--- /dev/null", "+++ b/model.ts", "@@ -0,0 +1,3 @@", "+a", "+b", "+c",
    "diff --git a/service.ts b/service.ts", "--- a/service.ts", "+++ b/service.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
    "diff --git a/handler.ts b/handler.ts", "--- a/handler.ts", "+++ b/handler.ts", "@@ -1,1 +1,2 @@", " keep", "+call", "",
  ].join("\n"),
};
const at = { base: "a".repeat(40), snapshot: "b".repeat(40) };
const step = (title, ...ranges) => ({ title, description: `${title}.`, ranges: ranges.map(([start, end]) => ({ start, end })) });

test("a complete step plan becomes the replay the page plays", () => {
  const replay = planReplay({ ...at, layout: "steps", steps: [{ ...step("Model", [1, 3]), impactful: true }, step("Service and handler", [4, 5], [6, 6])] }, PLAN_SESSION);
  assert.equal(replay.layout, undefined);
  assert.deepEqual(replay.chunks.map((chunk) => [chunk.title, chunk.impactful, chunk.ranges]), [
    ["Model", true, [{ file: "model.ts", start: 1, end: 3 }]],
    ["Service and handler", false, [{ file: "service.ts", start: 4, end: 5 }, { file: "handler.ts", start: 6, end: 6 }]],
  ]);
});

test("a tree plan is stored children first with index parents", () => {
  const replay = planReplay({ ...at, layout: "tree", nodes: [
    { id: "handler", parent: null, ...step("Handler", [6, 6]) },
    { id: "service", parent: "handler", ...step("Service", [4, 5]) },
    { id: "model", parent: "service", ...step("Model", [1, 3]) },
  ] }, PLAN_SESSION);
  assert.equal(replay.layout, "tree");
  assert.deepEqual(replay.chunks.map((chunk) => [chunk.title, chunk.parent]), [["Model", 1], ["Service", 2], ["Handler", null]]);
});

test("a plan is refused with every problem listed", () => {
  assert.throws(() => planReplay({ ...at, snapshot: "c".repeat(40), layout: "steps", steps: [step("All", [1, 6])] }, PLAN_SESSION), /now at bbbbbbbb against aaaaaaaa\. Run --list-lines again/);
  assert.throws(() => planReplay({ ...at, layout: "graph", steps: [] }, PLAN_SESSION), /"steps" or "tree"/);
  assert.throws(() => planReplay({ ...at, layout: "steps", nodes: [step("All", [1, 6])] }, PLAN_SESSION), /non-empty "steps" list/);
  assert.throws(() => planReplay({ ...at, layout: "steps", steps: [step("A", [1, 3]), step("B", [3, 4]), { title: "", ranges: [{ start: 0, end: 9 }] }] }, PLAN_SESSION), (error) => {
    assert.match(error.message, /^The plan has 5 problems:/);
    assert.match(error.message, /Step 3 needs a title\./);
    assert.match(error.message, /Step 3 needs a description\./);
    assert.match(error.message, /Step 3 has the range \{"start":0,"end":9\}; ranges are .* ≤ 6\./);
    assert.match(error.message, /No step covers changed lines 5–6\./);
    assert.match(error.message, /More than one step covers line 3\./);
    return true;
  });
  assert.throws(() => planReplay({ ...at, layout: "tree", nodes: [
    { id: "a", parent: null, ...step("A", [1, 3]) },
    { id: "b", parent: "a", ...step("B", [4, 5]) },
    { id: "a", parent: "missing", ...step("C", [6, 6]) },
  ] }, PLAN_SESSION), (error) => {
    assert.match(error.message, /Node 3 reuses the id "a"\./);
    assert.match(error.message, /Node 3 has the parent "missing", which is not another node's id\./);
    return true;
  });
  assert.throws(() => planReplay({ ...at, layout: "tree", nodes: [
    { id: "a", parent: "b", ...step("A", [1, 3]) },
    { id: "b", parent: "a", ...step("B", [4, 6]) },
  ] }, PLAN_SESSION), (error) => {
    assert.match(error.message, /The tree needs a root/);
    assert.match(error.message, /Node 1 is in a cycle of parents\./);
    return true;
  });
});

test("--list-lines numbers the snapshot's changed lines and a matching plan reaches the page", async (t) => {
  const { repo } = await fixture(t);
  await writeFile(join(repo, "app.txt"), "one\nTWO\nthree\nfour\nfive\n");
  await writeFile(join(repo, "new.txt"), "brand new\n");
  const listed = spawnSync(process.execPath, ["--experimental-strip-types", reviewer, "--repo", repo, "--base", "main", "--list-lines"], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^# Changed lines for a Chronosphere review plan: 3 lines in 2 files\./);
  const [, base, snapshot] = listed.stdout.match(/"base": "([0-9a-f]{40})", "snapshot": "([0-9a-f]{40})"/);
  assert.match(listed.stdout, /^== app\.txt \(modified\)$/m);
  assert.match(listed.stdout, /^\[1\] - two$/m);
  assert.match(listed.stdout, /^\[2\] \+ TWO$/m);
  assert.match(listed.stdout, /^\[3\] \+ brand new$/m);
  const plan = join(repo, "ignored.txt");
  await writeFile(plan, JSON.stringify({ base, snapshot, layout: "tree", nodes: [
    { id: "app", parent: null, ...step("Shout two", [1, 2]) },
    { id: "new", parent: "app", ...step("Add a file", [3, 3]) },
  ] }));
  const { call } = await connect(t, repo, "--plan", plan);
  const { session } = await (await call("/session")).json();
  assert.equal(session.head.sha, snapshot);
  assert.equal(session.replay.layout, "tree");
  assert.deepEqual(session.replay.chunks.map((chunk) => [chunk.title, chunk.parent]), [["Add a file", 1], ["Shout two", null]]);
});

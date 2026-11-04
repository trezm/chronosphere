import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { formatReview } from "../scripts/review.mjs";

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

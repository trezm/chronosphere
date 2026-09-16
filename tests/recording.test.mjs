import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { contentHash, parseRecording, recordingStateAt } from "../lib/recording.ts";

const recorder = resolve("scripts/record.mjs");
async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), "chronosphere-test-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", repo]);
  await writeFile(join(repo, ".gitignore"), ".chronosphere/\nignored.txt\n");
  const session = join(repo, ".chronosphere", "test.jsonl");
  function run(...args) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", recorder, ...args], { cwd: repo, encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  }
  function okay(...args) {
    const result = run(...args);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
  }
  function start(...args) { return okay("start", "--out", session, "--title", "Test session", ...args); }
  function checkpoint(title = "Edit") { return okay("checkpoint", "--session", session, "--title", title, "--reason", "Exercise a recorded change."); }
  const read = async () => parseRecording(await readFile(session, "utf8"));
  return { repo, session, run, okay, start, checkpoint, read };
}

test("recordings preserve dirty baselines, successive edits, additions, deletions, and reversals", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "math.js"), "original\n");
  execFileSync("git", ["-C", f.repo, "add", "math.js"]);
  await writeFile(join(f.repo, "math.js"), "dirty baseline\n");
  f.start();
  await writeFile(join(f.repo, "math.js"), "first attempt\n");
  await writeFile(join(f.repo, "temporary.js"), "trial\n");
  f.checkpoint("First attempt");
  await writeFile(join(f.repo, "math.js"), "dirty baseline\n");
  await rm(join(f.repo, "temporary.js"));
  f.checkpoint("Reverse attempt");
  f.okay("finish", "--session", f.session, "--title", "Done", "--reason", "Reverted the trial.");
  const log = await f.read();
  assert.equal(recordingStateAt(log, 0).get("math.js").content, "dirty baseline\n");
  assert.equal(recordingStateAt(log, 1).get("math.js").content, "first attempt\n");
  assert.equal(recordingStateAt(log, 1).get("temporary.js").content, "trial\n");
  assert.equal(recordingStateAt(log, 2).get("math.js").content, "dirty baseline\n");
  assert.equal(recordingStateAt(log, 2).has("temporary.js"), false);
  assert.deepEqual(log.events.map((event) => event.sequence), [1, 2, 3]);
  const closed = f.run("checkpoint", "--session", f.session, "--title", "Late", "--reason", "Too late");
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, /finished/);
});

test("command failures retain output, status, and command-created files, without attributing pending edits", async (t) => {
  const f = await fixture(t);
  f.start();
  await writeFile(join(f.repo, "pending.txt"), "pending");
  const args = ["run", "--session", f.session, "--title", "Failing test", "--reason", "Check the first attempt", "--", process.execPath, "-e", "require('fs').writeFileSync('result.txt', 'failed'); console.log('failure evidence'); process.exit(7)"];
  const blocked = f.run(...args);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /unrecorded edits/);
  f.checkpoint();
  const failed = f.run(...args);
  assert.equal(failed.status, 7);
  const log = await f.read();
  assert.equal(log.events[1].command.exitCode, 7);
  assert.match(log.events[1].command.output, /failure evidence/);
  assert.deepEqual(log.events[1].changes.map((change) => change.path), ["result.txt"]);
  assert.equal(recordingStateAt(log, 2).get("result.txt").content, "failed");
});

test("scope, ignored files, symlinks, binary data and sensitive names are respected", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "safe.txt"), "safe\n");
  await writeFile(join(f.repo, "ignored.txt"), "ignored");
  await writeFile(join(f.repo, ".env"), "SECRET=secret");
  await writeFile(join(f.repo, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(f.repo, "large.txt"), "x".repeat(256 * 1024 + 1));
  await symlink(join(f.repo, "safe.txt"), join(f.repo, "linked.txt"));
  f.start();
  let log = await f.read();
  assert.deepEqual(Object.keys(log.session.baseline).sort(), [".gitignore", "safe.txt"]);
  assert.deepEqual(log.session.omitted.map((item) => item.path), [".env", "binary.bin", "large.txt", "linked.txt"]);
  await writeFile(join(f.repo, "safe.txt"), Buffer.from([0, 0]));
  f.checkpoint();
  log = await f.read();
  assert.equal(log.events[0].changes.length, 0);
  assert.equal(log.events[0].omitted.some((item) => item.path === "safe.txt"), true);
  assert.equal(recordingStateAt(log, 1).get("safe.txt").content, "safe\n");
});

test("literal scope supports future files, unicode paths, empty content and renames", async (t) => {
  const f = await fixture(t);
  f.start("--include", "café file.txt", "--include", "renamed.txt");
  await writeFile(join(f.repo, "café file.txt"), "");
  await writeFile(join(f.repo, "outside.txt"), "not in scope");
  f.checkpoint();
  await rm(join(f.repo, "café file.txt"));
  await writeFile(join(f.repo, "renamed.txt"), "");
  f.checkpoint();
  const log = await f.read();
  assert.equal(recordingStateAt(log, 1).get("café file.txt").content, "");
  assert.deepEqual([...recordingStateAt(log, 2).keys()], ["renamed.txt"]);
});

test("imports reject tampering, missing events, broken patch preconditions and incomplete JSON", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "file.txt"), "one");
  f.start();
  await writeFile(join(f.repo, "file.txt"), "two"); f.checkpoint();
  await writeFile(join(f.repo, "file.txt"), "three"); f.checkpoint();
  const lines = (await readFile(f.session, "utf8")).trim().split("\n").map(JSON.parse);
  const stringify = (records) => records.map((value) => JSON.stringify(value)).join("\n");
  const tampered = structuredClone(lines);
  tampered[1].changes[0].after.content = "tampered";
  await assert.rejects(parseRecording(stringify(tampered)), /hash/);
  await assert.rejects(parseRecording(stringify([lines[0], lines[2]])), /missing, reordered/);
  const broken = structuredClone(lines);
  broken[2].changes[0].before = { content: "different", sha256: await contentHash("different") };
  await assert.rejects(parseRecording(stringify(broken)), /prior state/);
  await assert.rejects(parseRecording(`${stringify(lines)}\n{"type":`), /incomplete/);
  const path = structuredClone(lines);
  path[1].changes[0].path = "../outside";
  await assert.rejects(parseRecording(stringify(path)), /file path/);
});

test("exclusive locks prevent interleaved appends and existing sessions are never overwritten", async (t) => {
  const f = await fixture(t);
  f.start();
  const source = await readFile(f.session, "utf8");
  assert.equal(f.run("start", "--out", f.session, "--title", "Duplicate").status, 1);
  await writeFile(`${f.session}.lock`, "");
  const locked = f.run("checkpoint", "--session", f.session, "--title", "Concurrent", "--reason", "Test lock");
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /locked/);
  assert.equal(await readFile(f.session, "utf8"), source);
});

test("commands that cannot start still produce a recorded failure", async (t) => {
  const f = await fixture(t);
  f.start();
  const result = f.run("run", "--session", f.session, "--title", "Unavailable command", "--reason", "Check failure capture", "--", "chronosphere-nonexistent-command-123");
  assert.equal(result.status, 1);
  const log = await f.read();
  assert.equal(log.events[0].command.exitCode, null);
  assert.match(log.events[0].command.output, /Could not start command/);
});

test("a previously captured file that becomes ignored is omitted without reading new content", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "local.txt"), "public version");
  f.start();
  await writeFile(join(f.repo, ".gitignore"), ".chronosphere/\nlocal.txt\n");
  await writeFile(join(f.repo, "local.txt"), "private version");
  f.checkpoint();
  const log = await f.read();
  assert.equal(recordingStateAt(log, 1).get("local.txt").content, "public version");
  assert.deepEqual(log.events[0].omitted, [{ path: "local.txt", reason: "Now ignored by Git" }]);
  assert.equal((await readFile(f.session, "utf8")).includes("private version"), false);
});

test("PR export includes only a finished portable log and supports replacing the exported artifact", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "app.js"), "before\n");
  f.start();
  const pending = f.run("export", "--session", f.session);
  assert.equal(pending.status, 1);
  assert.match(pending.stderr, /Finish the session/);
  await writeFile(join(f.repo, "app.js"), "after\n");
  f.okay("finish", "--session", f.session, "--title", "Done", "--reason", "Ready for review");
  f.okay("export", "--session", f.session);
  const artifact = join(f.repo, ".chronosphere", "replay.jsonl");
  assert.equal(await readFile(artifact, "utf8"), await readFile(f.session, "utf8"));
  await assert.rejects(readFile(`${artifact}.local.json`), /ENOENT/);
  await writeFile(artifact, "old artifact");
  f.okay("export", "--session", f.session);
  assert.equal((await parseRecording(await readFile(artifact, "utf8"))).events[0].type, "finish");
  assert.equal(f.run("export", "--session", f.session, "--out", f.session).status, 1);
});

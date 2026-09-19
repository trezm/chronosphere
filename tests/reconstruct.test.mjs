import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseRecording, recordingStateAt } from "../lib/recording.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "chronosphere-reconstruct-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Copy only the distributed skill: no app imports, npm install, or sibling files.
  const skill = join(root, "skill");
  await cp(resolve("skills/chronosphere-reconstruct"), skill, { recursive: true });
  function run(...args) {
    return spawnSync("python3", [join(skill, "scripts/reconstruct.py"), ...args], { cwd: root, encoding: "utf8" });
  }
  function okay(...args) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result;
  }
  const source = join(root, "source.json"), plan = join(root, "plan.json"), output = join(root, "replay.jsonl");
  const build = () => run("build", "--source", source, "--plan", plan, "--out", output);
  const json = (file, value) => writeFile(file, JSON.stringify(value));
  return { root, run, okay, source, plan, output, build, json };
}

test("standalone skill uses the merge base and produces importable exact endpoint states", async (t) => {
  const f = await fixture(t);
  const repo = join(f.root, "repo");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const before = "\uFEFFconst café = 1;\r\nconst second = false;";
  const intermediate = "\uFEFFconst café = 2;\r\nconst second = false;";
  const after = "\uFEFFconst café = 2;\r\nconst second = true;";
  await writeFile(join(repo, "café file.js"), before);
  await writeFile(join(repo, "old.txt"), "rename me\n");
  await writeFile(join(repo, "gone.txt"), "remove me\n");
  await writeFile(join(repo, "mode.txt"), "unchanged\n");
  git("add", "."); git("commit", "--quiet", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "target-only.txt"), "not part of the PR\n");
  git("add", "."); git("commit", "--quiet", "-m", "Target advances");
  const targetBase = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "-b", "pr", base);
  await writeFile(join(repo, "café file.js"), after);
  await rename(join(repo, "old.txt"), join(repo, "renamed.txt"));
  await rm(join(repo, "gone.txt"));
  await writeFile(join(repo, "empty.txt"), "");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(repo, "non-utf8.bin"), Buffer.from([255, 254]));
  await writeFile(join(repo, "large.txt"), "x".repeat(256 * 1024 + 1));
  await writeFile(join(repo, ".env"), "SECRET=do not capture");
  await symlink("café file.js", join(repo, "link.js"));
  await chmod(join(repo, "mode.txt"), 0o755);
  await mkdir(join(repo, ".chronosphere"));
  await writeFile(join(repo, ".chronosphere/replay.jsonl"), "old recording");
  git("add", "."); git("commit", "--quiet", "-m", "PR changes");
  const head = git("rev-parse", "HEAD");
  await writeFile(join(repo, "café file.js"), "uncommitted user edits");
  const dirty = git("status", "--porcelain");
  f.okay("prepare", "--repo", repo, "--base", targetBase, "--head", head,
    "--name", "owner/repo", "--title", "PR #1234", "--out", f.source);
  assert.equal(git("status", "--porcelain"), dirty);
  assert.equal(await readFile(join(repo, "café file.js"), "utf8"), "uncommitted user edits");
  const source = JSON.parse(await readFile(f.source, "utf8"));
  assert.equal(source.base, base);
  assert.equal(source.targetBase, targetBase);
  assert.equal(source.repository.head, head);
  assert.equal(source.files["target-only.txt"], undefined);
  assert.deepEqual(source.files["café file.js"], { before, after });
  assert.deepEqual(source.omitted.map((item) => item.path).sort(), [".chronosphere/replay.jsonl", ".env", "binary.bin", "large.txt", "link.js", "mode.txt", "non-utf8.bin"]);
  assert.equal((await readFile(f.source, "utf8")).includes("SECRET="), false);
  await f.json(f.plan, { steps: [
    { title: "First change", reason: "Change the first constant.", snapshots: { "café file.js": intermediate } },
    { title: "Finish behavior", reason: "Complete the remaining changes.", files: Object.keys(source.files) },
  ] });
  const built = f.build();
  assert.equal(built.status, 0, built.stderr);
  const replay = await parseRecording(await readFile(f.output, "utf8"));
  assert.match(replay.session.title, /^Reconstructed:/);
  assert.equal(replay.session.repository.head, base);
  assert.equal(replay.session.reconstruction.head, head);
  assert.match(replay.events[0].reason, /order is inferred, not observed/);
  assert.deepEqual(replay.events.map((event) => event.type), ["change", "change", "finish"]);
  assert.equal(recordingStateAt(replay, 0).get("café file.js").content, before);
  assert.equal(recordingStateAt(replay, 1).get("café file.js").content, intermediate);
  const final = recordingStateAt(replay, replay.events.length);
  assert.deepEqual([...final.keys()].sort(), ["café file.js", "empty.txt", "renamed.txt"]);
  for (const [name, value] of final) {
    assert.equal(value.content, execFileSync("git", ["-C", repo, "show", `${head}:${name}`], { encoding: "utf8" }));
  }
  const original = await readFile(f.output, "utf8");
  assert.equal(f.build().status, 1, "Do not overwrite an existing output");
  assert.equal(await readFile(f.output, "utf8"), original);
});

test("connector manifests require complete plans and reject invalid or misleading transitions", async (t) => {
  const f = await fixture(t);
  const source = { title: "Connector PR", repository: { name: "owner/repo", head: "b".repeat(40), branch: null },
    base: "a".repeat(40), files: { "one.txt": { before: "before", after: "after" }, "new.txt": { before: null, after: "" } }, omitted: [] };
  await f.json(f.source, source);
  const step = { title: "Change", reason: "Apply the change.", files: ["one.txt", "new.txt"] };
  const cases = [
    [{ ...step, files: ["one.txt"] }, /does not reach pinned head/],
    [{ ...step, files: ["unknown.txt"] }, /absent from source/],
    [{ ...step, files: ["one.txt", "one.txt"] }, /Duplicate file/],
    [{ ...step, snapshots: { "one.txt": "intermediate" } }, /Duplicate file/],
    [{ ...step, files: [], snapshots: { "one.txt": "before" } }, /No-op/],
    [{ ...step, files: [], snapshots: { "one.txt": "x".repeat(256 * 1024 + 1) } }, /256 KiB/],
    [{ ...step, command: { output: "Tests pass" } }, /Unknown step fields/],
    [{ ...step, files: [] }, /Empty reconstruction/],
  ];
  for (const [candidate, message] of cases) {
    await f.json(f.plan, { steps: [candidate] });
    const result = f.build();
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  await f.json(f.plan, { steps: [step] });
  for (const [name, message] of [["../escape", /Unsupported path/], [".env", /Excluded/]]) {
    await f.json(f.source, { ...source, files: { [name]: { before: null, after: "data" } } });
    assert.match(f.build().stderr, message);
  }
  await f.json(f.source, source);
  const result = f.build();
  assert.equal(result.status, 0, result.stderr);
  const replay = await parseRecording(await readFile(f.output, "utf8"));
  assert.equal(recordingStateAt(replay, 2).get("new.txt").content, "");
});

test("source inputs reject duplicate keys rather than silently losing a changed file", async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, '{"files":{},"files":{}}');
  await f.json(f.plan, { steps: [] });
  const result = f.build();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Duplicate JSON key/);
});

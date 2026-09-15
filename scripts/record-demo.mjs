#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const repo = await mkdtemp(join(tmpdir(), "chronosphere-demo-"));
const recorder = resolve("scripts/record.mjs");
const recording = resolve(`.chronosphere/recordings/demo-${randomUUID()}.jsonl`);
function record(args, expected = 0) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", recorder, ...args], { cwd: repo, encoding: "utf8" });
  if (result.status !== expected) throw new Error(result.stderr || result.stdout || "Demo recorder failed.");
}
function checkpoint(title, reason) { record(["checkpoint", "--session", recording, "--title", title, "--reason", reason]); }
function check(title, expected) { record(["run", "--session", recording, "--title", title, "--reason", "The total should equal the sum of the input values.", "--", process.execPath, "--test", "total.test.mjs"], expected); }
try {
  execFileSync("git", ["init", "--quiet", repo]);
  await writeFile(join(repo, "total.mjs"), "// A total implementation will go here.\n");
  record(["start", "--out", recording, "--title", "Demo: implement a total, catch a mistake, and fix it"]);
  await writeFile(join(repo, "total.mjs"), "export function total(values) {\n  return values.length;\n}\n");
  await writeFile(join(repo, "total.test.mjs"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { total } from './total.mjs';\ntest('adds input values', () => assert.equal(total([2, 3]), 5));\n");
  checkpoint("Add the first implementation and test", "Start with a function and an example that checks the intended result.");
  check("The example fails", 1);
  await writeFile(join(repo, "total.mjs"), "export function total(values) {\n  return values.reduce((sum, value) => sum + value, 0);\n}\n");
  checkpoint("Sum the values", "The failed test showed that the implementation counted values instead of adding them.");
  check("The example passes", 0);
  await writeFile(join(repo, "scratch.md"), "Could a loop be easier to read?\n");
  checkpoint("Capture an alternative", "Consider a loop implementation before settling on reduce.");
  await rm(join(repo, "scratch.md"));
  checkpoint("Remove the scratch note", "Keep the tested implementation. This temporary file does not survive in the final workspace.");
  record(["finish", "--session", recording, "--title", "Finish the experiment", "--reason", "The total test passes; the temporary note has been removed."]);
  console.log(`Open /recordings and choose:\n${recording}`);
} finally { await rm(repo, { recursive: true, force: true }); }

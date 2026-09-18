#!/usr/bin/env -S node --experimental-strip-types
import { compressRecording } from "../lib/recording-transport.ts";
import { open, readFile, mkdir, lstat, realpath, unlink, rename } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { contentHash, parseRecording, recordingStateAt, RECORDING_MAX_BYTES, RECORDING_MAX_EVENTS, RECORDING_MAX_FILE_BYTES } from "../lib/recording.ts";

const HELP = `Chronosphere local recorder (Node 22.13+; use --experimental-strip-types)
  start --title 'Task' [--repo PATH] [--include PATH ...] [--out FILE]
  checkpoint --session FILE --title 'Change' --reason 'Why'
  run --session FILE --title 'Check' --reason 'Why' -- COMMAND [ARGS...]
  finish --session FILE --title 'Done' --reason 'Outcome'
  inspect --session FILE
  export --session FILE [--out FILE] [--compress]

Paths in --include are literal repository-relative files or directories; default: .
The default log is .chronosphere/recordings/<session-id>.jsonl (keep it local).
Checkpoints observe current text files, not every intermediate edit. 'run' records
the command result and any file changes, and returns the command's exit status.
Binary, symlink, sensitive-name, and >256 KB files are omitted. No uploads.
Export copies a finished recording to .chronosphere/replay.jsonl for a PR.
Use export --compress --out /temporary/replay.json for a gzip+Base64 gist upload.
`;

function args(argv) {
  const options = { include: [] };
  const operation = argv.shift();
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--compress") { options.compress = true; continue; }
    if (flag === "--") { options.command = argv; break; }
    if (!["--repo", "--include", "--out", "--session", "--title", "--reason"].includes(flag) || !argv.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    const value = argv.shift();
    if (flag === "--include") options.include.push(value); else options[flag.slice(2)] = value;
  }
  return { operation, options };
}
function git(repo, ...argv) { return execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", maxBuffer: RECORDING_MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] }).trimEnd(); }
function gitOptional(repo, ...argv) { try { return git(repo, ...argv); } catch { return null; } }
function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 8000) throw new Error(`${label} is required (maximum 8000 characters).`);
  return value;
}
function validScope(value) {
  if (value !== "." && (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(value))) throw new Error("--include must be a literal repository-relative path.");
  return value;
}
function excluded(name) {
  return name.split("/").some((part) => [".git", ".chronosphere", "node_modules", ".next", ".vinext", ".wrangler", "dist", "coverage"].includes(part)) || /(^|\/)(\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519))$/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
}

async function snapshot(repo, scope, previous = new Map()) {
  const eligible = new Set(git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean));
  const candidates = new Set([...eligible, ...previous.keys()]);
  const files = new Map(), omitted = [];
  let size = 0;
  for (const name of [...candidates].sort()) {
    if (!scope.some((prefix) => prefix === "." || name === prefix || name.startsWith(`${prefix}/`))) continue;
    validScope(name);
    let reason = excluded(name) ? "Excluded name" : !eligible.has(name) ? "Now ignored by Git" : null;
    const target = resolve(repo, name);
    let stat;
    try { stat = await lstat(target); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!reason && (!stat.isFile() || stat.isSymbolicLink())) reason = "Not a regular file";
    if (!reason && stat.size > RECORDING_MAX_FILE_BYTES) reason = "Larger than 256 KB";
    if (!reason) {
      const actual = await realpath(target);
      if (!actual.startsWith(`${repo}${sep}`) || actual !== target) reason = "Symlink or outside repository";
    }
    let content;
    if (!reason) {
      const bytes = await readFile(target);
      if (bytes.length > RECORDING_MAX_FILE_BYTES) reason = "Larger than 256 KB";
      else if (bytes.includes(0)) reason = "Binary file";
      else { try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { reason = "Not UTF-8 text"; } }
    }
    if (reason) {
      omitted.push({ path: name, reason });
      // Preserve last known text rather than inventing a deletion for an unreadable file.
      if (previous.has(name)) files.set(name, previous.get(name));
      continue;
    }
    size += Buffer.byteLength(content);
    if (size > 8 * 1024 * 1024 || files.size >= 5000) throw new Error("Snapshot is too large. Start a new session with a narrower --include scope.");
    files.set(name, { content, sha256: await contentHash(content) });
  }
  return { files, omitted };
}
function changesBetween(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const oldFile = before.get(path) ?? null, newFile = after.get(path) ?? null;
    return oldFile?.sha256 === newFile?.sha256 ? [] : [{ path, before: oldFile, after: newFile }];
  });
}
async function durableWrite(file, content, flags) {
  const handle = await open(file, flags, 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function execute(argv, cwd) {
  if (!argv?.length) throw new Error("run requires -- COMMAND [ARGS...]");
  let output = "", truncated = false;
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const capture = (chunk, stream) => {
      stream.write(chunk);
      const room = Math.max(0, 32000 - output.length);
      const data = chunk.toString();
      output += data.slice(0, room);
      truncated ||= data.length > room;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
    child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
    child.on("error", (error) => {
      if (error.code === "ENOENT" || error.code === "EACCES") {
        resolveResult({ argv, exitCode: null, signal: null, output: `Could not start command: ${error.message}`, truncated: false });
      } else reject(error);
    });
    child.on("close", (exitCode, signal) => resolveResult({ argv, exitCode, signal, output, truncated }));
  });
}

export async function main(argv) {
  if (!argv.length || argv[0] === "--help") { console.log(HELP); return 0; }
  const { operation, options } = args([...argv]);
  if (!["start", "checkpoint", "run", "finish", "inspect", "export"].includes(operation)) throw new Error(`Unknown operation: ${operation}`);
  if (options.compress && operation !== "export") throw new Error("--compress is only supported by export.");
  if (operation === "start") {
    const repo = await realpath(git(resolve(options.repo ?? "."), "rev-parse", "--show-toplevel"));
    const scope = (options.include.length ? options.include : ["."]).map(validScope);
    const title = text(options.title, "--title"), id = randomUUID();
    const destination = resolve(options.out ?? `${repo}/.chronosphere/recordings/${id}.jsonl`);
    // The log and local locator must not capture themselves, including with --out.
    const outputInRepo = relative(repo, destination);
    if (!outputInRepo.startsWith("..") && !outputInRepo.startsWith(`.chronosphere${sep}`)) throw new Error("Place --out outside the repository or inside .chronosphere/.");
    const { files, omitted } = await snapshot(repo, scope);
    const session = { type: "session", format: "chronosphere.recording", version: 1, id, createdAt: new Date().toISOString(), title, capture: "checkpoints", repository: { name: basename(repo), head: gitOptional(repo, "rev-parse", "HEAD"), branch: gitOptional(repo, "symbolic-ref", "--short", "HEAD") }, scope, baseline: Object.fromEntries(files), omitted };
    const source = `${JSON.stringify(session)}\n`;
    if (Buffer.byteLength(source) > RECORDING_MAX_BYTES) throw new Error("Starting snapshot exceeds 20 MB when encoded. Use a narrower --include scope.");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await durableWrite(destination, source, "wx");
    // Local-only locator: absolute paths never enter the portable recording.
    await durableWrite(`${destination}.local.json`, JSON.stringify({ repo, sessionId: id }), "wx");
    console.log(destination);
    console.log(`Captured ${files.size} text files; omitted ${omitted.length}.`);
    return 0;
  }
  const destination = resolve(text(options.session, "--session"));
  if (operation === "export") {
    const source = await readFile(destination, "utf8");
    const recording = await parseRecording(source);
    if (recording.events.at(-1)?.type !== "finish") throw new Error("Finish the session before exporting a recording for a PR.");
    if (options.compress && !options.out) throw new Error("Compressed export requires --out /temporary/replay.json; the committed replay path remains plain JSONL.");
    const exported = options.compress ? await compressRecording(source) : source;
    let output;
    if (options.out) output = resolve(options.out);
    else {
      const locator = JSON.parse(await readFile(`${destination}.local.json`, "utf8"));
      if (locator.sessionId !== recording.session.id) throw new Error("Local locator belongs to a different session.");
      output = resolve(locator.repo, ".chronosphere/replay.jsonl");
    }
    if (output === destination || output === `${destination}.local.json`) throw new Error("Export must not overwrite the original session or its local locator.");
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const temporary = `${output}.${randomUUID()}.tmp`;
    try { await durableWrite(temporary, exported, "wx"); await rename(temporary, output); }
    finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    if (options.compress) console.log(`Compressed ${Buffer.byteLength(source)} bytes to ${Buffer.byteLength(exported)} bytes (gzip+Base64).`);
    console.log(`Exported recording for your PR:\n${output}\n${options.compress ? "Upload replay.json to the gist only after user approval." : "Commit only the exported .jsonl;"} keep raw sessions and .local.json files local.`);
    return 0;
  }
  if (operation === "inspect") {
    const recording = await parseRecording(await readFile(destination, "utf8"));
    console.log(JSON.stringify({ title: recording.session.title, events: recording.events.length, files: recordingStateAt(recording, recording.events.length).size, finished: recording.events.at(-1)?.type === "finish" }, null, 2));
    return 0;
  }
  const title = text(options.title, "--title"), reason = text(options.reason, "--reason");
  const lock = `${destination}.lock`;
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Session is locked by another recorder. If it crashed, remove the .lock file only after confirming it is no longer running."); throw error; }
  try {
    const source = await readFile(destination, "utf8");
    const recording = await parseRecording(source);
    if (!source.endsWith("\n")) throw new Error("Recording is missing its final newline; refusing to append.");
    if (recording.events.at(-1)?.type === "finish") throw new Error("This recording is finished. Start a new session.");
    if (recording.events.length >= RECORDING_MAX_EVENTS) throw new Error("Recording has reached its event limit.");
    const locator = JSON.parse(await readFile(`${destination}.local.json`, "utf8"));
    if (locator.sessionId !== recording.session.id) throw new Error("Local locator belongs to a different session.");
    const repo = await realpath(locator.repo);
    const previous = recordingStateAt(recording, recording.events.length);
    if (operation === "run") {
      const beforeCommand = await snapshot(repo, recording.session.scope, previous);
      if (changesBetween(previous, beforeCommand.files).length) throw new Error("There are unrecorded edits. Capture a checkpoint before running a command so its changes have the right explanation.");
    }
    const command = operation === "run" ? await execute(options.command, repo) : undefined;
    const current = await snapshot(repo, recording.session.scope, previous);
    const event = { type: operation === "checkpoint" ? "change" : operation === "run" ? "command" : "finish", id: randomUUID(), sequence: recording.events.length + 1, recordedAt: new Date().toISOString(), title, reason, changes: changesBetween(previous, current.files), omitted: current.omitted, ...(command ? { command } : {}) };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(source) + Buffer.byteLength(line) > RECORDING_MAX_BYTES) throw new Error("Recording would exceed 20 MB. Start a new scoped session.");
    await durableWrite(destination, line, "a");
    console.log(`Recorded #${event.sequence}: ${title} (${event.changes.length} changed files, ${event.omitted.length} omitted).`);
    return command ? command.exitCode ?? 1 : 0;
  } finally { await handle.close(); await unlink(lock); }
}

// Node resolves module URLs through symlinks, but preserves the CLI argument.
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

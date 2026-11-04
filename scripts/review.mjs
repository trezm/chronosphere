#!/usr/bin/env -S node --experimental-strip-types
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { copyFile, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRecording, RECORDING_MAX_BYTES } from "../lib/recording.ts";

const DEFAULT_APP = "https://getchronosphere.com";
const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 4_000_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const EXCERPT_RADIUS = 2;

const HELP = `Chronosphere local review (Node 22.13+; use --experimental-strip-types)
  review.mjs [--repo PATH] [--base REF] [--title TEXT] [--recording FILE]
             [--app URL] [--port N] [--timeout MINUTES] [--json] [--no-open]

Snapshots the working copy (commits, staged, unstaged, and untracked files Git
does not ignore) against its merge base with --base (default: origin/HEAD, then
main or master). It serves the snapshot from 127.0.0.1, opens the review link,
and waits. When the review is submitted it prints the verdict, summary, and
comments on stdout and exits 0. Progress and the link go to stderr.
--recording attaches a chronosphere-record session as the replay.
Exit 2: --timeout passed with no review. Exit 130: interrupted.
Nothing is uploaded: the Chronosphere page reads the snapshot from this process.
`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function args(argv) {
  const options = { open: true, json: false };
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--help" || flag === "-h") { options.help = true; continue; }
    if (flag === "--no-open") { options.open = false; continue; }
    if (flag === "--json") { options.json = true; continue; }
    if (!["--repo", "--base", "--title", "--recording", "--app", "--port", "--timeout"].includes(flag) || !argv.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flag.slice(2)] = argv.shift();
  }
  return options;
}

function git(repo, argv, { env, encoding = "utf8", maxBuffer = MAX_DIFF_BYTES } = {}) {
  return execFileSync("git", ["-C", repo, ...argv], { encoding, maxBuffer, env: env ? { ...process.env, ...env } : process.env, stdio: ["ignore", "pipe", "pipe"] });
}
function gitLine(repo, ...argv) { return git(repo, argv).trimEnd(); }
function gitOptional(repo, ...argv) { try { return gitLine(repo, ...argv) || null; } catch { return null; } }

function defaultBase(repo) {
  const remoteHead = gitOptional(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  for (const candidate of [remoteHead, "origin/main", "origin/master", "main", "master"]) {
    if (candidate && gitOptional(repo, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`)) return candidate;
  }
  throw new Error("Could not find a base branch. Pass --base REF.");
}

/**
 * Writes the working copy to a tree object through a throwaway index, so the
 * snapshot includes uncommitted and untracked files while the real index and
 * working tree stay untouched. Content stays pinned even if editing continues.
 */
async function snapshotTree(repo) {
  const directory = await mkdtemp(join(tmpdir(), "chronosphere-review-"));
  try {
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    // Starting from a copy of the real index keeps its stat cache, so unchanged files are not rehashed.
    try { await copyFile(resolve(repo, gitLine(repo, "rev-parse", "--git-path", "index")), env.GIT_INDEX_FILE); }
    catch { git(repo, ["read-tree", "HEAD"], { env }); }
    git(repo, ["add", "--all", "--", "."], { env });
    return git(repo, ["write-tree"], { env }).trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function repositoryName(repo) {
  const remote = gitOptional(repo, "remote", "get-url", "origin");
  const match = remote?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? basename(repo);
}

async function readRecording(file) {
  const path = resolve(file);
  if ((await stat(path)).size > RECORDING_MAX_BYTES) throw new Error("--recording exceeds the 20 MB limit.");
  const source = await readFile(path, "utf8");
  const { session } = await parseRecording(source);
  return { id: session.id, name: basename(path), source };
}

async function snapshot(options) {
  const repo = gitLine(resolve(options.repo ?? "."), "rev-parse", "--show-toplevel");
  const commit = gitOptional(repo, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  if (!commit) throw new Error("The repository has no commits to compare against.");
  const base = options.base ?? defaultBase(repo);
  const mergeBase = gitOptional(repo, "merge-base", base, commit);
  if (!mergeBase) throw new Error(`${base} shares no history with HEAD. Pass --base REF.`);
  const tree = await snapshotTree(repo);
  let diff;
  try {
    // Explicit flags override user diff configuration that would change the format GitHub serves.
    diff = git(repo, ["-c", "core.quotePath=false", "-c", "diff.suppressBlankEmpty=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--find-renames", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", mergeBase, tree, "--", ".", ":(exclude).chronosphere"]);
  } catch (error) {
    throw error.code === "ENOBUFS" ? new Error("These changes are larger than the 20 MB diff limit.") : error;
  }
  if (!diff.trim()) throw new Error(`There are no changes against ${base}.`);
  if (!/^@@ /m.test(diff)) throw new Error(`Only binary or mode changes differ from ${base}; there are no lines to review.`);
  const branch = gitOptional(repo, "symbolic-ref", "--quiet", "--short", "HEAD");
  const commits = (gitOptional(repo, "log", "--reverse", "--format=%H %s", `${mergeBase}..${commit}`) ?? "").split("\n").filter(Boolean)
    .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
  const uncommitted = tree !== gitLine(repo, "rev-parse", `${commit}^{tree}`);
  const title = options.title?.trim() || (commits.length === 1 && !uncommitted ? commits[0].subject : `Local changes on ${branch ?? "a detached HEAD"}`);
  const body = [
    commits.length ? `Commits since ${base}:\n${commits.map((item) => `- ${item.subject}`).join("\n")}` : "",
    uncommitted ? "Includes uncommitted and untracked changes." : "",
  ].filter(Boolean).join("\n\n");
  return {
    repo,
    session: {
      format: "chronosphere.local-review", version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
      repository: { name: repositoryName(repo), branch },
      title, body,
      base: { ref: base, sha: mergeBase },
      head: { sha: tree, commit, uncommitted },
      commits, diff,
      recording: options.recording ? await readRecording(options.recording) : null,
    },
  };
}

function validPath(value) {
  return typeof value === "string" && !!value && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes("\0"));
}

function fileContent(repo, session, ref, path) {
  if (ref !== session.base.sha && ref !== session.head.sha) throw new HttpError(400, "Only the reviewed base and snapshot can be read.");
  if (!validPath(path)) throw new HttpError(400, "A valid repository file path is required.");
  let content;
  try { content = git(repo, ["cat-file", "blob", `${ref}:${path}`], { maxBuffer: MAX_FILE_BYTES }); }
  catch (error) { throw error.code === "ENOBUFS" ? new HttpError(413, "This file is too large to expand inline.") : new HttpError(404, `${path} does not exist in that version.`); }
  return content;
}

function parseReview(raw, session) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "The review must be JSON."); }
  if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(body?.event)) throw new HttpError(400, "Choose a valid review action.");
  if (body.headSha !== session.head.sha) throw new HttpError(409, "This review is for a different snapshot. Reopen the link from the latest review command.");
  if (body.comments !== undefined && !Array.isArray(body.comments)) throw new HttpError(400, "Comments must be a list.");
  const comments = (body.comments ?? []).map((comment) => {
    if (!validPath(comment?.path) || !Number.isInteger(comment.line) || comment.line < 1 || !["LEFT", "RIGHT"].includes(comment.side) || typeof comment.body !== "string" || !comment.body.trim()) {
      throw new HttpError(400, "Every comment needs a valid diff line and message.");
    }
    return { path: comment.path, line: comment.line, side: comment.side, body: comment.body.trim() };
  });
  const summary = typeof body.body === "string" ? body.body.trim() : "";
  // Unlike GitHub, a bare approval is a complete answer for a waiting agent.
  if (!comments.length && !summary && body.event !== "APPROVE") throw new HttpError(400, "Add a summary or at least one comment.");
  return { event: body.event, summary, comments };
}

function excerpt(repo, session, comment) {
  try {
    const lines = fileContent(repo, session, comment.side === "LEFT" ? session.base.sha : session.head.sha, comment.path).replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = Math.max(1, comment.line - EXCERPT_RADIUS);
    return { startLine: start, lines: lines.slice(start - 1, Math.min(lines.length, comment.line + EXCERPT_RADIUS)) };
  } catch { return null; }
}

const VERDICTS = { APPROVE: "approved", REQUEST_CHANGES: "changes requested", COMMENT: "comments" };

function fenced(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function formatReview(review, session) {
  const short = (sha) => sha.slice(0, 8);
  const head = session.head.uncommitted ? `commit \`${short(session.head.commit)}\` plus uncommitted changes` : `commit \`${short(session.head.commit)}\``;
  const out = [
    `# Chronosphere review: ${VERDICTS[review.event]}`,
    "",
    `Reviewed snapshot \`${short(session.head.sha)}\` of ${session.repository.branch ? `\`${session.repository.branch}\`` : "a detached HEAD"} (${head}) against \`${session.base.ref}\` at \`${short(session.base.sha)}\`. Line numbers refer to that snapshot; files may have changed since.`,
  ];
  if (review.summary) out.push("", "## Summary", "", review.summary);
  out.push("", `## Comments (${review.comments.length})`);
  if (!review.comments.length) out.push("", "No line comments.");
  review.comments.forEach((comment, index) => {
    out.push("", `### ${index + 1}. ${comment.path}:${comment.line}${comment.side === "LEFT" ? " (removed line, base version)" : ""}`);
    if (comment.excerpt) {
      const width = String(comment.excerpt.startLine + comment.excerpt.lines.length - 1).length;
      out.push("", fenced(comment.excerpt.lines.map((text, offset) => {
        const number = comment.excerpt.startLine + offset;
        return `${number === comment.line ? ">" : " "} ${String(number).padStart(width)} | ${text}`;
      }).join("\n")));
    }
    out.push("", comment.body);
  });
  return `${out.join("\n")}\n`;
}

function openBrowser(url) {
  const [command, argv] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, argv, { stdio: "ignore", detached: true });
    child.on("error", () => process.stderr.write("Could not open a browser; open the link above.\n"));
    child.unref();
  } catch { process.stderr.write("Could not open a browser; open the link above.\n"); }
}

async function requestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "The review is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Serves one snapshot to the review page and resolves with the review it submits. */
export function serveReview({ repo, session, appOrigin, port = 0, onOpened = () => {} }) {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  let opened = false;
  let resolveReview;
  const reviewed = new Promise((resolvePromise) => { resolveReview = resolvePromise; });
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(body));
    };
    try {
      const { port: listening } = server.address();
      // A rebinding attack reaches this port under another host name; only loopback names are answered.
      if (![`127.0.0.1:${listening}`, `localhost:${listening}`].includes(request.headers.host ?? "")) throw new HttpError(403, "Unexpected host.");
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== appOrigin) throw new HttpError(403, "This review link belongs to another Chronosphere address.");
      if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
          // Only browsers from before Local Network Access send this Private Network Access preflight.
          ...(request.headers["access-control-request-private-network"] === "true" ? { "Access-Control-Allow-Private-Network": "true" } : {}),
        });
        response.end();
        return;
      }
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, "This review link's access token is missing or wrong.");
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/session") {
        if (!opened) { opened = true; onOpened(); }
        send(200, { session });
      } else if (request.method === "GET" && url.pathname === "/file") {
        send(200, { content: fileContent(repo, session, url.searchParams.get("ref"), url.searchParams.get("path")) });
      } else if (request.method === "POST" && url.pathname === "/review") {
        const review = parseReview(await requestBody(request), session);
        send(200, { ok: true });
        resolveReview(review);
      } else {
        throw new HttpError(404, "Not found.");
      }
    } catch (error) {
      send(error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : "Something went wrong." });
    }
  });
  const ready = new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveReady(server.address().port));
  });
  const close = () => { server.closeAllConnections(); server.close(); };
  return { token, ready, reviewed, close };
}

export function reviewLink(appOrigin, port, token) {
  return `${appOrigin}/local#${new URLSearchParams({ port: String(port), token })}`;
}

export async function main(argv) {
  const options = args(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  let appOrigin;
  try { appOrigin = new URL(options.app ?? process.env.CHRONOSPHERE_URL ?? DEFAULT_APP).origin; }
  catch { throw new Error("--app must be a URL such as https://getchronosphere.com."); }
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a TCP port number.");
  const timeout = options.timeout === undefined ? null : Number(options.timeout);
  if (timeout !== null && !(timeout > 0)) throw new Error("--timeout must be a positive number of minutes.");

  const { repo, session } = await snapshot(options);
  const files = session.diff.match(/^diff --git /gm)?.length ?? 0;
  const bridge = serveReview({ repo, session, appOrigin, port, onOpened: () => process.stderr.write("The review page is open.\n") });
  const link = reviewLink(appOrigin, await bridge.ready, bridge.token);
  process.stderr.write(`Snapshot ${session.head.sha.slice(0, 8)}: ${files} changed file${files === 1 ? "" : "s"} against ${session.base.ref}${session.recording ? `, replaying ${session.recording.name}` : ""}.\nReview link: ${link}\nWaiting for the review to be submitted (Ctrl-C to cancel)…\n`);
  if (options.open) openBrowser(link);

  const stop = (code, message) => { bridge.close(); process.stderr.write(message); process.exit(code); };
  process.once("SIGINT", () => stop(130, "Review cancelled before it was submitted.\n"));
  process.once("SIGTERM", () => stop(143, "Review cancelled before it was submitted.\n"));
  if (timeout !== null) setTimeout(() => stop(2, `No review was submitted within ${timeout} minute${timeout === 1 ? "" : "s"}.\n`), timeout * 60_000).unref();

  const review = await bridge.reviewed;
  bridge.close();
  const comments = review.comments.map((comment) => ({ ...comment, excerpt: excerpt(repo, session, comment) }));
  const result = { ...review, comments };
  process.stdout.write(options.json
    ? `${JSON.stringify({ ...result, snapshot: { tree: session.head.sha, commit: session.head.commit, uncommitted: session.head.uncommitted, branch: session.repository.branch, base: session.base.ref, mergeBase: session.base.sha } }, null, 2)}\n`
    : formatReview(result, session));
  return 0;
}

// Node resolves module URLs through symlinks, but preserves the CLI argument.
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  // exitCode rather than exit(), so a long review on a pipe is not cut off.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

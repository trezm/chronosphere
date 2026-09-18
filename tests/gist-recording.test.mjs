import assert from "node:assert/strict";
import test from "node:test";
import { GIST_RECORDING_MAX_BYTES, loadGistRecording, replayGistFromBody } from "../lib/gist-recording.ts";
import { contentHash, parseRecording } from "../lib/recording.ts";
import { compressRecording } from "../lib/recording-transport.ts";

const id = "a".repeat(32), revision = "b".repeat(40);
const url = `https://gist.github.com/author/${id}`;
const raw = `https://gist.githubusercontent.com/author/${id}/raw/${revision}/replay.jsonl`;
const tag = (value = url) => `chronosphere-replay: ${value}`;

test("PR gist tags accept links and immutable revision permalinks", () => {
  assert.deepEqual(replayGistFromBody(`PR description\n\n${tag()}\n`), { id, url });
  assert.deepEqual(replayGistFromBody(tag(`${url}/${revision}`)), { id, revision, url: `${url}/${revision}` });
  assert.deepEqual(replayGistFromBody(tag(`https://gist.github.com/${id}`)), { id, url: `https://gist.github.com/${id}` });
  assert.deepEqual(replayGistFromBody(tag(`https://gist.github.com/${id}/${revision}`)), { id, revision, url: `https://gist.github.com/${id}/${revision}` });
  assert.equal(replayGistFromBody(null), null);
});

test("examples in code fences, indented code and quotations do not attach a gist", () => {
  assert.equal(replayGistFromBody(`Example:\n\n\`\`\`text\n${tag()}\n\`\`\``), null);
  assert.equal(replayGistFromBody(`~~~text\n${tag()}\n~~~`), null);
  assert.equal(replayGistFromBody(`    ${tag()}\n> ${tag()}`), null);
  assert.deepEqual(replayGistFromBody(`\`\`\`\`text\n\`\`\`\n${tag()}\n\`\`\`\`\n${tag()}`), { id, url });
});

test("duplicate or malformed tags fail rather than falling back to another recording", () => {
  assert.throws(() => replayGistFromBody(`${tag()}\n${tag()}`), /exactly one/);
  for (const value of ["", "http://gist.github.com/author/aaaaa", "https://example.com/a", `${url}?other=file`, `${url}#file`, `${url} trailing text`, `https://gist.github.com@evil.example/${id}`, `https://gist.github.com.evil.example/${id}`, `https://gist.github.com/author/../${id}`, `https://gist.github.com/author/%61aaaa`, `https://gist.github.com/author/${id}/../${revision}`]) {
    assert.throws(() => replayGistFromBody(tag(value)), /GitHub gist URL/, value);
  }
});

function fixture(source, overrides = {}) {
  const calls = [];
  const request = async (target, options) => {
    calls.push({ target, options });
    if (calls.length === 1) return Response.json({ files: { "replay.jsonl": { size: Buffer.byteLength(source), raw_url: raw, content: "truncated API content", truncated: true, ...overrides } } });
    return new Response(source);
  };
  return { calls, request };
}

test("gist loading uses raw content at a pinned revision and never forwards credentials", async () => {
  const source = "é".repeat(600_000); // Larger than the Gist API's embedded-content limit.
  const { calls, request } = fixture(source);
  assert.equal(await loadGistRecording(replayGistFromBody(tag(`${url}/${revision}`)), request), source);
  assert.equal(calls[0].target, `https://api.github.com/gists/${id}/${revision}`);
  assert.equal(calls[1].target, raw);
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(new Headers(options.headers).has("Authorization"), false);
  }
});

test("raw downloads must match the expected host, gist, immutable file hash and filename", async () => {
  for (const raw_url of ["https://localhost/replay.jsonl", raw.replace("gist.githubusercontent.com", "evil.example"), raw.replace(id, "c".repeat(32)), raw.replace(revision, "latest"), raw.replace("replay.jsonl", "credentials.json"), raw + "?redirect=1", raw.replace("https://", "https://user:secret@"), raw.replace("/raw/", "/../raw/")]) {
    const { request, calls } = fixture("valid", { raw_url });
    await assert.rejects(loadGistRecording(replayGistFromBody(tag(`${url}/${revision}`)), request), /unexpected replay download URL/);
    assert.equal(calls.length, 1);
  }
});

test("revision-pinned gist metadata can reference a different immutable raw-file hash", async () => {
  const rawFile = raw.replace(revision, "c".repeat(40));
  const { request, calls } = fixture("original file", { raw_url: rawFile });
  assert.equal(await loadGistRecording({ id, url, revision }, request), "original file");
  assert.equal(calls[0].target, `https://api.github.com/gists/${id}/${revision}`);
  assert.equal(calls[1].target, rawFile);
});

test("missing, oversized and incomplete gist files fail explicitly", async () => {
  await assert.rejects(loadGistRecording({ id, url }, async () => Response.json({ files: {} })), /named replay.jsonl/);
  for (const size of [GIST_RECORDING_MAX_BYTES + 1, -1, undefined, "20"]) {
    const { request, calls } = fixture("body", { size });
    await assert.rejects(loadGistRecording({ id, url }, request), /10 MB/);
    assert.equal(calls.length, 1);
  }
  await assert.rejects(loadGistRecording({ id, url }, fixture("partial", { size: 100 }).request), /incomplete/);
  let calls = 0;
  await assert.rejects(loadGistRecording({ id, url }, async () => ++calls === 1
    ? Response.json({ files: { "replay.jsonl": { raw_url: raw, size: 10 } } })
    : new Response(new Uint8Array(GIST_RECORDING_MAX_BYTES + 1))), /size limit/);
});

test("unavailable metadata and raw downloads surface errors", async () => {
  for (const status of [403, 404, 500]) {
    await assert.rejects(loadGistRecording({ id, url }, async () => new Response("", { status })), new RegExp(`GitHub ${status}`));
  }
  let calls = 0;
  await assert.rejects(loadGistRecording({ id, url }, async () => ++calls === 1
    ? Response.json({ files: { "replay.jsonl": { raw_url: raw, size: 1 } } })
    : new Response("", { status: 404 })), /download.*404/);
});

test("downloaded logs still pass through recording hash and event validation", async () => {
  const content = "recorded code\n";
  const session = { type: "session", format: "chronosphere.recording", version: 1, capture: "checkpoints", id: "session", title: "Gist review", createdAt: "2026-09-17T00:00:00Z", repository: { name: "repo", head: null, branch: "main" }, scope: ["."], baseline: { "app.js": { content, sha256: await contentHash(content) } }, omitted: [] };
  const source = JSON.stringify(session) + "\n";
  assert.equal((await parseRecording(await loadGistRecording({ id, url }, fixture(source).request))).session.id, "session");
  await assert.rejects(parseRecording(await loadGistRecording({ id, url }, fixture(source.replace("recorded code", "tampered code")).request)), /hash/i);
});

test("compressed gist files are decoded before playback and ambiguous files are rejected", async () => {
  const source = "original JSONL content\n".repeat(2000);
  const compressed = await compressRecording(source);
  let calls = 0;
  const request = async (target) => {
    if (++calls === 1) return Response.json({ files: { "replay.json": { raw_url: raw.replace(".jsonl", ".json"), size: Buffer.byteLength(compressed) } } });
    assert.equal(target, raw.replace(".jsonl", ".json"));
    return new Response(compressed);
  };
  assert.equal(await loadGistRecording({ id, url }, request), source);
  await assert.rejects(loadGistRecording({ id, url }, async () => Response.json({ files: { "replay.json": {}, "replay.jsonl": {} } })), /exactly one replay file/);
});

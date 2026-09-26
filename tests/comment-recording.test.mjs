import assert from "node:assert/strict";
import test from "node:test";
import { loadCommentRecording, replayFromComments } from "../lib/comment-recording.ts";
import { compressRecording } from "../lib/recording-transport.ts";

const attachment = "https://github.com/user-attachments/files/12345678/replay.json";
const signed = "https://objects.githubusercontent.com/github-production-repository-file/replay.json?X-Amz-Signature=abc";
const tag = (value = attachment) => `chronosphere-replay: ${value}`;
let next = 1;
const comment = (body, overrides = {}) => ({
  id: next++, html_url: `https://github.com/o/r/pull/1#issuecomment-${next}`, body,
  created_at: "2026-09-01T00:00:00Z", user: { login: "author" }, author_association: "NONE", ...overrides,
});

test("the newest tagged comment from the PR author or a collaborator wins", () => {
  const older = comment(`[replay.json](${attachment})\n\n${tag()}`);
  const newer = comment(tag(attachment.replace("12345678", "99")), { created_at: "2026-09-02T00:00:00Z", user: { login: "maintainer" }, author_association: "MEMBER" });
  assert.deepEqual(replayFromComments([newer, older, comment("LGTM")], "author"), { id: newer.id, url: newer.html_url, attachment: attachment.replace("12345678", "99") });
  assert.equal(replayFromComments([comment("No replay here")], "author"), null);
  assert.equal(replayFromComments([], "author"), null);
});

test("tags from untrusted commenters or inside code fences are ignored", () => {
  const outsider = comment(tag(), { user: { login: "someone" }, author_association: "CONTRIBUTOR" });
  assert.equal(replayFromComments([outsider], "author"), null);
  assert.equal(replayFromComments([comment(`\`\`\`text\n${tag()}\n\`\`\``), comment(`> ${tag()}`)], "author"), null);
});

test("duplicate or malformed tags fail rather than falling back to another recording", () => {
  assert.throws(() => replayFromComments([comment(`${tag()}\n${tag()}`)], "author"), /exactly one/);
  for (const value of ["", "https://gist.github.com/author/aaaaa", attachment.replace("https://", "http://"), `${attachment}?x=1`, attachment.replace("replay.json", "replay.jsonl"), attachment.replace("12345678", "../1"), attachment.replace("github.com", "github.com.evil.example"), `https://github.com@evil.example/user-attachments/files/1/replay.json`]) {
    assert.throws(() => replayFromComments([comment(tag(value))], "author"), /GitHub attachment URL/, value);
  }
});

test("attachments follow one redirect and only send the token to github.com", async () => {
  const source = '{"type":"session"}\n';
  const calls = [];
  const request = async (target, options) => {
    calls.push({ target, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: signed } }) : new Response(await compressRecording(source));
  };
  assert.equal(await loadCommentRecording({ id: 1, url: "", attachment }, "token", request), source);
  assert.equal(calls[0].target, attachment);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(new Headers(calls[0].options.headers).get("Authorization"), "Bearer token");
  assert.equal(calls[1].target, signed);
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(new Headers(calls[1].options.headers).has("Authorization"), false);
});

test("sign-in redirects, failures and plain files are reported as unavailable or invalid", async () => {
  for (const location of ["https://github.com/login?return_to=x", "http://objects.githubusercontent.com/x", "https://user:pw@example.com/x"]) {
    await assert.rejects(loadCommentRecording({ id: 1, url: "", attachment }, "t", async () => new Response(null, { status: 302, headers: { location } })), /did not serve/, location);
  }
  await assert.rejects(loadCommentRecording({ id: 1, url: "", attachment }, "t", async () => new Response("missing", { status: 404 })), /did not serve/);
  await assert.rejects(loadCommentRecording({ id: 1, url: "", attachment }, "t", async () => new Response("<html>")), /compressed Chronosphere recording/);
});

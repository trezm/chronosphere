import assert from "node:assert/strict";
import test from "node:test";
import { REFRESH_MARGIN_MS, ensureGithubSession, refreshGithubToken } from "../lib/github-auth.ts";

const NOW = 1_800_000_000_000;
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const credentials = { clientId: "id", clientSecret: "secret", now: () => NOW };

function session(overrides = {}) {
  return { accessToken: "old-access", refreshToken: "old-refresh", login: "pete", name: null, avatarUrl: "", ...overrides };
}

function github({ user = () => Response.json({ login: "pete" }), token = () => Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 28800 }) } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, authorization: init?.headers?.Authorization });
    if (url === TOKEN_URL) return token();
    if (url === USER_URL) return user();
    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, fetch };
}

test("leaves a session without GitHub alone", async () => {
  assert.deepEqual(await ensureGithubSession(undefined, credentials), { status: "absent", github: undefined, changed: false });
});

test("keeps a non-expiring token that GitHub still accepts", async () => {
  const api = github();
  const current = session({ refreshToken: undefined });
  const check = await ensureGithubSession(current, { ...credentials, fetch: api.fetch });
  assert.deepEqual(check, { status: "valid", github: current, changed: false });
  assert.deepEqual(api.calls.map((call) => call.url), [USER_URL]);
  assert.equal(api.calls[0].authorization, "Bearer old-access");
});

test("refreshes an expired token with the stored refresh token", async () => {
  const api = github();
  const check = await ensureGithubSession(session({ expiresAt: NOW - 1000 }), { ...credentials, fetch: api.fetch });
  assert.equal(check.status, "valid");
  assert.equal(check.changed, true);
  assert.deepEqual(check.github, { ...session(), accessToken: "new-access", refreshToken: "new-refresh", expiresAt: NOW + 28800 * 1000 });
  assert.deepEqual(api.calls.map((call) => call.url), [TOKEN_URL], "a fresh token needs no separate validation");
  assert.deepEqual(api.calls[0].body, { client_id: "id", client_secret: "secret", grant_type: "refresh_token", refresh_token: "old-refresh" });
});

test("refreshes ahead of the expiry margin", async () => {
  const api = github();
  const check = await ensureGithubSession(session({ expiresAt: NOW + REFRESH_MARGIN_MS - 1 }), { ...credentials, fetch: api.fetch });
  assert.equal(check.changed, true);
  assert.equal(check.github.accessToken, "new-access");
});

test("signs out when GitHub rejects the refresh token of an expired session", async () => {
  const api = github({ token: () => Response.json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }) });
  const check = await ensureGithubSession(session({ expiresAt: NOW - 1 }), { ...credentials, fetch: api.fetch });
  assert.deepEqual(check, { status: "expired", github: undefined, changed: true });
  assert.deepEqual(api.calls.map((call) => call.url), [TOKEN_URL]);
});

test("signs out an expired token that has no refresh token", async () => {
  const api = github();
  const check = await ensureGithubSession(session({ refreshToken: undefined, expiresAt: NOW - 1 }), { ...credentials, fetch: api.fetch });
  assert.equal(check.status, "expired");
  assert.equal(api.calls.length, 0);
});

test("signs out a revoked token GitHub no longer accepts", async () => {
  const api = github({ user: () => Response.json({ message: "Bad credentials" }, { status: 401 }) });
  const check = await ensureGithubSession(session({ refreshToken: undefined }), { ...credentials, fetch: api.fetch });
  assert.equal(check.status, "expired");
});

test("tries a refresh once when a token GitHub rejects still has a refresh token", async () => {
  const api = github({ user: () => Response.json({ message: "Bad credentials" }, { status: 401 }) });
  const check = await ensureGithubSession(session(), { ...credentials, fetch: api.fetch });
  assert.equal(check.status, "valid");
  assert.equal(check.github.accessToken, "new-access");
  assert.deepEqual(api.calls.map((call) => call.url), [USER_URL, TOKEN_URL]);
});

test("keeps the session when GitHub is unreachable or failing", async () => {
  const offline = github({ user: () => { throw new Error("offline"); } });
  const current = session();
  assert.deepEqual(await ensureGithubSession(current, { ...credentials, fetch: offline.fetch }), { status: "valid", github: current, changed: false });
  const outage = github({ user: () => Response.json({ message: "down" }, { status: 503 }) });
  assert.equal((await ensureGithubSession(current, { ...credentials, fetch: outage.fetch })).changed, false);
});

test("falls back to validating a still-valid token when the early refresh fails transiently", async () => {
  const api = github({ token: () => Response.json({ message: "down" }, { status: 502 }) });
  const current = session({ expiresAt: NOW + 60_000 });
  const check = await ensureGithubSession(current, { ...credentials, fetch: api.fetch });
  assert.deepEqual(check, { status: "valid", github: current, changed: false });
  assert.deepEqual(api.calls.map((call) => call.url), [TOKEN_URL, USER_URL]);
});

test("cannot refresh without OAuth app credentials", async () => {
  const api = github();
  assert.deepEqual(await refreshGithubToken(session(), { fetch: api.fetch, now: () => NOW }), { ok: false, permanent: true });
  assert.equal(api.calls.length, 0);
});

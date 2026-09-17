import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError, authorizedFetch, onGithubSessionExpired } from "../lib/api.ts";

function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  return run(calls).finally(() => { globalThis.fetch = originalFetch; });
}

test("preserves API response status for callers that handle failures", () => withFetch(
  () => Response.json({ error: "A valid owner/repository is required." }, { status: 400 }),
  async (calls) => {
    await assert.rejects(api("/api/github/pulls?repo=x"), (error) => error instanceof ApiError && error.status === 400 && error.message === "A valid owner/repository is required.");
    assert.equal(calls.length, 1, "a 400 is not a session problem and is not retried");
  },
));

test("refreshes the GitHub session after a 401 and retries the request once", () => withFetch(
  (url, init, call) => {
    if (url === "/api/auth/session") return Response.json({ github: { connected: true } });
    return call === 1 ? Response.json({ error: "GitHub authentication is required." }, { status: 401 }) : Response.json({ repositories: [] });
  },
  async (calls) => {
    const expired = [];
    const stop = onGithubSessionExpired(() => expired.push(true));
    try {
      assert.deepEqual(await api("/api/github/repos", { method: "GET" }), { repositories: [] });
      assert.deepEqual(calls.map((call) => call.url), ["/api/github/repos", "/api/auth/session", "/api/github/repos"]);
      assert.equal(calls[2].init.method, "GET", "the retry reuses the original request options");
      assert.equal(expired.length, 0);
    } finally {
      stop();
    }
  },
));

test("reports an expired session when the refresh fails and keeps the 401", () => withFetch(
  (url) => (url === "/api/auth/session"
    ? Response.json({ github: { connected: false, user: null, expired: true } })
    : Response.json({ error: "GitHub: Bad credentials" }, { status: 401 })),
  async (calls) => {
    const expired = [];
    const stop = onGithubSessionExpired(() => expired.push(true));
    try {
      await assert.rejects(api("/api/github/repos"), (error) => error instanceof ApiError && error.status === 401 && error.message === "GitHub: Bad credentials");
      assert.deepEqual(calls.map((call) => call.url), ["/api/github/repos", "/api/auth/session"]);
      assert.equal(expired.length, 1);
    } finally {
      stop();
    }
  },
));

test("shares one session check across concurrent 401s", () => withFetch(
  (url, init, call) => {
    if (url === "/api/auth/session") return Response.json({ github: { connected: true } });
    return call <= 2 ? Response.json({ error: "GitHub authentication is required." }, { status: 401 }) : Response.json({ ok: true });
  },
  async (calls) => {
    const [first, second] = await Promise.all([authorizedFetch("/api/github/repos"), authorizedFetch("/api/github/pulls?repo=a/b")]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.filter((call) => call.url === "/api/auth/session").length, 1);
  },
));

test("never tries to refresh the session endpoint itself", () => withFetch(
  () => Response.json({ error: "nope" }, { status: 401 }),
  async (calls) => {
    const response = await authorizedFetch("/api/auth/session");
    assert.equal(response.status, 401);
    assert.equal(calls.length, 1);
  },
));

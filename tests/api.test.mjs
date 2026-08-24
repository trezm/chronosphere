import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError, isApiErrorWithStatus } from "../lib/api.ts";

test("preserves API response status for callers that handle credential failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "GitHub: Bad credentials" }, { status: 400 });

  try {
    await assert.rejects(
      api("/api/github/repos"),
      (error) => error instanceof ApiError
        && error.status === 400
        && error.message === "GitHub: Bad credentials"
        && isApiErrorWithStatus(error, 400, 401),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not classify unrelated API failures as repository credential failures", () => {
  assert.equal(isApiErrorWithStatus(new ApiError("Server error", 500), 400, 401), false);
});

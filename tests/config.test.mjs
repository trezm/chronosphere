import assert from "node:assert/strict";
import test from "node:test";
import { defaultOpenRouterModel, FALLBACK_OPENROUTER_MODEL } from "../lib/config.ts";

test("resolves the OpenRouter default model from the environment", () => {
  const original = process.env.OPENROUTER_MODEL;
  try {
    process.env.OPENROUTER_MODEL = "  openai/gpt-5.6-luna  ";
    assert.equal(defaultOpenRouterModel(), "openai/gpt-5.6-luna");

    process.env.OPENROUTER_MODEL = "   ";
    assert.equal(defaultOpenRouterModel(), FALLBACK_OPENROUTER_MODEL);
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = original;
  }
});

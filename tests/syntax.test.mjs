import assert from "node:assert/strict";
import test from "node:test";
import { highlightLines, languageForPath } from "../lib/syntax.ts";

test("selects a syntax grammar from common repository paths", () => {
  assert.equal(languageForPath("app/page.tsx"), "ts");
  assert.equal(languageForPath("infra/Dockerfile.production"), "docker");
  assert.equal(languageForPath("Makefile"), "make");
  assert.equal(languageForPath("config/settings.yml"), "yaml");
});

test("preserves source lines while tokenizing multiline syntax", async () => {
  const source = ["const message = `hello", "world`;", "// done"];
  const highlighted = await highlightLines(source, "ts");

  assert.equal(highlighted.length, source.length);
  assert.deepEqual(highlighted.map((line) => line.map((token) => token.text).join("")), source);
  assert.ok(highlighted[0].some((token) => token.type === "kwd"));
  assert.ok(highlighted[1].some((token) => token.type === "str"));
  assert.ok(highlighted[2].some((token) => token.type === "cmnt"));
});

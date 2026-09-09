import assert from "node:assert/strict";
import test from "node:test";
import { describeOpenRouterError, lineBuffer, openRouterError, OpenRouterError, openRouterFrame, parseReplayEvent, readOpenRouterContent, readReplayEvents } from "../lib/replay-stream.ts";

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test("releases only complete lines and keeps the trailing partial line", () => {
  const lines = lineBuffer();
  assert.deepEqual(lines.push('{"a":1}\n{"b'), ['{"a":1}']);
  assert.deepEqual(lines.push('":2}\n'), ['{"b":2}']);
  assert.deepEqual(lines.push("tail"), []);
  assert.deepEqual(lines.flush(), ["tail"]);
  assert.deepEqual(lines.flush(), []);
});

test("ignores OpenRouter keep-alives, the done sentinel, and contentless frames", () => {
  assert.equal(openRouterFrame(": OPENROUTER PROCESSING"), null);
  assert.equal(openRouterFrame(""), null);
  assert.equal(openRouterFrame("data: [DONE]"), null);
  assert.equal(openRouterFrame('data: {"choices":[{"delta":{}}]}'), null);
  assert.equal(openRouterFrame("data: not json"), null);
  assert.deepEqual(openRouterFrame('data: {"choices":[{"delta":{"content":"hi"}}]}'), { content: "hi" });
});

test("accumulates model content across SSE frames split mid-line", async () => {
  const deltas = await collect(readOpenRouterContent(streamOf([
    ": OPENROUTER PROCESSING\n\n",
    'data: {"choices":[{"delta":{"content":"{\\"chu"}}]}\n\ndata: {"choices":[{"del',
    'ta":{"content":"nks\\":[]}"}}]}\n\n',
    "data: [DONE]\n",
  ])));

  assert.deepEqual(deltas, ['{"chu', 'nks":[]}']);
  assert.equal(deltas.join(""), '{"chunks":[]}');
});

test("surfaces an OpenRouter error frame as a thrown build failure", async () => {
  await assert.rejects(
    collect(readOpenRouterContent(streamOf([
      'data: {"choices":[{"delta":{"content":"{"}}]}\n',
      'data: {"error":{"message":"openai/nope is not a valid model ID"}}\n',
    ]))),
    { message: "openai/nope is not a valid model ID" },
  );
});

test("keeps OpenRouter's provider, code, and raw upstream error on a mid-stream failure", async () => {
  const payload = {
    id: "gen-1", provider: "Azure",
    error: { code: 500, message: "Provider returned error", metadata: { raw: '{"error":"upstream exploded"}', provider_name: "Azure" } },
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
  };
  const frame = `data: ${JSON.stringify(payload)}\n`;
  await assert.rejects(collect(readOpenRouterContent(streamOf([frame]))), (error) => {
    assert.ok(error instanceof OpenRouterError);
    assert.equal(error.message, 'Provider returned error (Azure, code 500): {"error":"upstream exploded"}');
    assert.deepEqual(error.details(), {
      message: error.message, status: undefined, code: 500, provider: "Azure", raw: '{"error":"upstream exploded"}', generationId: undefined,
    });
    return true;
  });
});

test("names the failure even when OpenRouter's error frame carries no message", () => {
  const frame = openRouterFrame('data: {"provider":"Wafer","error":{"code":"server_error"}}');
  assert.ok("error" in frame);
  assert.equal(frame.error.message, "OpenRouter reported an error mid-stream (Wafer, code server_error)");
  assert.equal(openRouterFrame('data: {"error":"plain string"}').error.message, "plain string");
  assert.equal(openRouterError({}), null);
  assert.equal(openRouterError(null), null);
});

test("describes a non-2xx response from its status when the body is not JSON", () => {
  assert.equal(describeOpenRouterError(undefined, { status: 502 }), "OpenRouter returned 502.");
  assert.equal(describeOpenRouterError(undefined, { status: 500, raw: "<html>bad gateway</html>" }), "OpenRouter returned 500: <html>bad gateway</html>");
  assert.equal(describeOpenRouterError("Rate limited", { status: 429, code: 429, provider: "OpenAI" }), "Rate limited (OpenAI)");
  assert.equal(describeOpenRouterError("x", { raw: "y".repeat(300) }).length, "x: ".length + 200 + 1);
});

test("reads the replay event protocol through to the done event", async () => {
  const replay = { model: "openai/gpt-5-mini", truncated: false, chunks: [{ ranges: [{ file: "lib/replay.ts", start: 1, end: 3 }], title: "Add", description: "One step.", impactful: false }] };
  const events = await collect(readReplayEvents(streamOf([
    '{"type":"progress","chars":512}\n{"type":"progress","cha',
    'rs":2048}\n{"type":"parsing"}\n',
    `${JSON.stringify({ type: "done", replay })}\n`,
  ])));

  assert.deepEqual(events, [
    { type: "progress", chars: 512 },
    { type: "progress", chars: 2048 },
    { type: "parsing" },
    { type: "done", replay },
  ]);
});

test("reads a terminal error event and skips unusable lines", async () => {
  const events = await collect(readReplayEvents(streamOf([
    '{"type":"progress","chars":64}\n',
    "\n",
    "half a line that never parses\n",
    '{"type":"error","error":"OpenRouter returned 401."}',
  ])));

  assert.deepEqual(events, [
    { type: "progress", chars: 64 },
    { type: "error", error: "OpenRouter returned 401." },
  ]);
});

test("keeps a malformed event from masquerading as progress", () => {
  assert.equal(parseReplayEvent('{"type":"progress"}'), null);
  assert.equal(parseReplayEvent('{"type":"done"}'), null);
  assert.equal(parseReplayEvent("   "), null);
  assert.deepEqual(parseReplayEvent('{"type":"error"}'), { type: "error", error: "Could not build the replay." });
});

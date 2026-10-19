import assert from "node:assert/strict";
import test from "node:test";
import { answerLineQuestion, lineQuestionContext, numberedLines } from "../lib/line-question.ts";

const target = {
  repo: "acme/app",
  pullNumber: 7,
  pullTitle: "Add totals",
  ref: "a".repeat(40),
  path: "src/math.ts",
  line: 2,
  side: "RIGHT",
  lineText: "  return values.length;",
  fileContent: "export function total(values) {\n  return values.length;\n}\n",
  recordedStep: null,
  diff: "diff --git a/src/math.ts b/src/math.ts\n",
};

const noTools = {
  listFiles: async () => [],
  readFile: async () => "",
  searchCode: async () => [],
};

test("numbers lines and marks the focused one", () => {
  assert.equal(numberedLines("a\nb\nc\n", 2, 3, 3), " 2 | b\n>3 | c");
  assert.equal(numberedLines("one\n", -5, 99), " 1 | one");
});

test("context names the selected line and includes a marked excerpt", () => {
  const context = lineQuestionContext(target);
  assert.match(context, /Selected line: src\/math\.ts:2, from the PR's head version/);
  assert.match(context, />2 \|   return values\.length;/);
  assert.match(lineQuestionContext({ ...target, recordedStep: "step 3" }), /recorded development checkpoint \(step 3\)/);
});

test("runs requested tools and feeds results back before answering", async () => {
  const seen = [];
  const answer = await answerLineQuestion({
    target,
    history: [{ role: "user", content: "Is total used anywhere else?" }],
    tools: {
      ...noTools,
      searchCode: async (query) => [{ path: "src/report.ts", fragments: [`${query}(rows)`] }],
    },
    complete: async ({ messages, tools }) => {
      seen.push({ messages: structuredClone(messages), tools });
      if (seen.length === 1) {
        return { content: null, toolCalls: [{ id: "c1", type: "function", function: { name: "search_code", arguments: JSON.stringify({ query: "total" }) } }] };
      }
      return { content: "Yes, src/report.ts:4 calls it.", toolCalls: [] };
    },
  });
  assert.equal(answer.answer, "Yes, src/report.ts:4 calls it.");
  assert.deepEqual(answer.toolCalls, [{ name: "search_code", argument: "total" }]);
  const toolMessage = seen[1].messages.at(-1);
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "c1");
  assert.match(toolMessage.content, /src\/report\.ts\n  total\(rows\)/);
  assert.match(seen[0].messages[2].content, /^Question about src\/math\.ts:2: Is total used/);
});

test("reports tool failures to the model instead of throwing", async () => {
  let toolResult = "";
  await answerLineQuestion({
    target,
    history: [{ role: "user", content: "Read it" }],
    tools: { ...noTools, readFile: async () => { throw new Error("404 Not Found"); } },
    complete: async ({ messages }) => {
      const last = messages.at(-1);
      if (last.role === "tool") { toolResult = last.content; return { content: "Could not read it.", toolCalls: [] }; }
      return { content: null, toolCalls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"missing.ts\"}" } }] };
    },
  });
  assert.equal(toolResult, "Error: 404 Not Found");
});

test("stops offering tools after the round limit", async () => {
  let calls = 0;
  const answer = await answerLineQuestion({
    target,
    history: [{ role: "user", content: "Loop" }],
    tools: noTools,
    complete: async ({ tools }) => {
      calls++;
      if (!tools) return { content: "Final answer.", toolCalls: [] };
      return { content: null, toolCalls: [{ id: `c${calls}`, type: "function", function: { name: "list_files", arguments: "{\"prefix\":\"\"}" } }] };
    },
  });
  assert.equal(answer.answer, "Final answer.");
  assert.equal(calls, 7);
});

test("requires the conversation to end with a question", async () => {
  await assert.rejects(answerLineQuestion({
    target, tools: noTools, history: [{ role: "assistant", content: "Hi" }],
    complete: async () => ({ content: "x", toolCalls: [] }),
  }), /Ask a question/);
});

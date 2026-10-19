/**
 * Answers a reviewer's free-form question about one line of a pull request.
 * The model sees the line, its file, and the PR diff, and may call a few
 * read-only repository tools (list files, read a file, search code) before it
 * answers, so questions like "is this used anywhere else?" get grounded answers.
 */

export interface LineQuestionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LineQuestionTarget {
  repo: string;
  pullNumber: number;
  pullTitle: string;
  ref: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  lineText: string;
  /** Full file text the line belongs to, when known. */
  fileContent: string | null;
  /** Set when the line comes from a recorded checkpoint rather than the final PR. */
  recordedStep: string | null;
  diff: string;
}

export interface LineQuestionTools {
  listFiles(prefix: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  searchCode(query: string): Promise<Array<{ path: string; fragments: string[] }>>;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatCompletion = (input: { messages: ChatMessage[]; tools: typeof TOOL_DEFINITIONS | null }) => Promise<{
  content: string | null;
  toolCalls: ToolCall[];
}>;

export interface LineAnswer {
  answer: string;
  toolCalls: Array<{ name: string; argument: string }>;
}

const MAX_TOOL_ROUNDS = 6;
const MAX_DIFF_CHARS = 120_000;
const EXCERPT_RADIUS = 150;
const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_LISTED_FILES = 400;

const SYSTEM = `You are a senior engineer helping someone review a pull request. They clicked one line of code and asked a question about it.
Answer the question directly and concisely, grounded in the code you have been shown or have looked up with tools. When the answer depends on code you have not seen (for example, whether something is used elsewhere), use the tools to check before answering instead of guessing. If you still cannot verify something, say what you checked and what remains uncertain.
Cite code as path:line. Use short plain-text paragraphs or "-" bullet lists; wrap identifiers and short code in backticks. Do not restate the question.`;

export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "search_code",
      description: "Search the repository for an identifier or text. Uses GitHub code search, which indexes the default branch, so code added only in this PR may not appear; combine with read_file for files in the diff.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Identifier or literal text, e.g. parseUnifiedDiff" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file at the pull request's head commit. Lines are numbered.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", description: "First line to return (1-based). Optional." },
          end_line: { type: "integer", description: "Last line to return. Optional." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List repository file paths at the pull request's head commit that start with a prefix.",
      parameters: {
        type: "object",
        properties: { prefix: { type: "string", description: "Directory prefix such as src/lib/, or empty for the root." } },
        required: ["prefix"],
      },
    },
  },
];

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

/** Numbers lines start..end (1-based, inclusive), marking `focus` with ">". */
export function numberedLines(content: string, start = 1, end = Infinity, focus: number | null = null): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = Math.max(1, Math.floor(start));
  const last = Math.min(lines.length, Math.floor(end));
  const width = String(last).length;
  const out: string[] = [];
  for (let line = first; line <= last; line++) {
    out.push(`${line === focus ? ">" : " "}${String(line).padStart(width)} | ${lines[line - 1]}`);
  }
  return out.join("\n");
}

export function lineQuestionContext(target: LineQuestionTarget): string {
  const where = target.recordedStep
    ? `a recorded development checkpoint (${target.recordedStep}); this version of the file may differ from the final PR`
    : target.side === "LEFT" ? "the base (pre-PR) version of the file" : "the PR's head version of the file";
  const excerpt = target.fileContent
    ? numberedLines(target.fileContent, target.line - EXCERPT_RADIUS, target.line + EXCERPT_RADIUS, target.line)
    : null;
  const diff = target.diff.length > MAX_DIFF_CHARS ? `${target.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : target.diff;
  return `Repository: ${target.repo}
PR #${target.pullNumber}: ${target.pullTitle}

Selected line: ${target.path}:${target.line}, from ${where}.
> ${target.lineText}

${excerpt ? `File excerpt around the selected line (marked with ">"):\n${excerpt}` : "(The file contents could not be loaded; use read_file if needed.)"}

Pull request diff:
${diff}`;
}

async function runTool(tools: LineQuestionTools, call: ToolCall): Promise<{ argument: string; result: string }> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return { argument: call.function.arguments, result: "Error: arguments were not valid JSON." };
  }
  try {
    switch (call.function.name) {
      case "search_code": {
        const query = String(args.query ?? "").trim();
        if (!query) return { argument: "", result: "Error: query is required." };
        const hits = await tools.searchCode(query);
        const result = hits.length
          ? hits.map((hit) => `${hit.path}\n${hit.fragments.map((fragment) => `  ${fragment.replace(/\n/g, "\n  ")}`).join("\n  ...\n")}`).join("\n\n")
          : "No matches on the default branch.";
        return { argument: query, result };
      }
      case "read_file": {
        const path = String(args.path ?? "").trim();
        const start = Number(args.start_line) || 1;
        const end = Number(args.end_line) || Infinity;
        const content = await tools.readFile(path);
        return { argument: path, result: numberedLines(content, start, end) || "(empty file)" };
      }
      case "list_files": {
        const prefix = String(args.prefix ?? "").trim().replace(/^\/+/, "");
        const files = await tools.listFiles(prefix);
        const shown = files.slice(0, MAX_LISTED_FILES);
        const more = files.length > shown.length ? `\n[${files.length - shown.length} more]` : "";
        return { argument: prefix || "/", result: shown.length ? `${shown.join("\n")}${more}` : "No files with that prefix." };
      }
      default:
        return { argument: "", result: `Error: unknown tool ${call.function.name}.` };
    }
  } catch (error) {
    return { argument: String(args.query ?? args.path ?? args.prefix ?? ""), result: `Error: ${error instanceof Error ? error.message : "tool failed"}` };
  }
}

export async function answerLineQuestion(input: {
  target: LineQuestionTarget;
  history: LineQuestionMessage[];
  complete: ChatCompletion;
  tools: LineQuestionTools;
}): Promise<LineAnswer> {
  const history = input.history.filter((message) => message.content.trim());
  if (!history.length || history.at(-1)!.role !== "user") throw new Error("Ask a question about this line.");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: lineQuestionContext(input.target) },
    ...history.map((message, index) => ({
      role: message.role,
      content: index === 0 ? `Question about ${input.target.path}:${input.target.line}: ${message.content}` : message.content,
    }) as ChatMessage),
  ];
  const toolCalls: LineAnswer["toolCalls"] = [];
  for (let round = 0; ; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS;
    const response = await input.complete({ messages, tools: allowTools ? TOOL_DEFINITIONS : null });
    if (!allowTools || !response.toolCalls.length) {
      const answer = response.content?.trim();
      if (!answer) throw new Error("The model returned an empty answer.");
      return { answer, toolCalls };
    }
    messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });
    for (const call of response.toolCalls) {
      const { argument, result } = await runTool(input.tools, call);
      toolCalls.push({ name: call.function.name, argument });
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(result, MAX_TOOL_RESULT_CHARS) });
    }
  }
}

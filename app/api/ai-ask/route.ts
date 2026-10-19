import { NextRequest } from "next/server";
import { withoutRecordingDiff } from "@/lib/pr-recording";
import { answerLineQuestion, type ChatCompletion, type LineQuestionMessage, type ToolCall } from "@/lib/line-question";
import { defaultReviewerModel } from "@/lib/config";
import { githubFetch, githubJson, githubToken, jsonError, parsePullNumber, parseRepo } from "@/lib/github";
import { readSession } from "@/lib/session";

export const maxDuration = 120;

const MAX_QUESTION_CHARS = 4_000;
const MAX_HISTORY = 20;
const MAX_FILE_CHARS = 1_000_000;

function parsePath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  const segments = path.split("/");
  if (!path || path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("A valid repository file path is required.");
  }
  return path;
}

function parseHistory(value: unknown): LineQuestionMessage[] {
  if (!Array.isArray(value)) throw new Error("A question is required.");
  return value.slice(-MAX_HISTORY).map((item) => {
    const { role, content } = (item ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") throw new Error("Invalid conversation history.");
    return { role, content: content.slice(0, MAX_QUESTION_CHARS) };
  });
}

function openRouterCompletion(apiKey: string, model: string): ChatCompletion {
  return async ({ messages, tools }) => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
        "X-Title": "Chronosphere",
      },
      body: JSON.stringify({ model, temperature: 0.2, messages, ...(tools ? { tools } : {}) }),
    });
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message || `OpenRouter returned ${response.status}.`);
    const message = body.choices?.[0]?.message;
    return { content: message?.content ?? null, toolCalls: message?.tool_calls ?? [] };
  };
}

export async function POST(request: NextRequest) {
  try {
    const session = await readSession(request);
    if (!session.openrouter?.apiKey) throw new Error("OpenRouter authentication is required.");
    const token = await githubToken(request);
    const input = (await request.json()) as {
      repo?: string;
      number?: number;
      headSha?: string;
      model?: string;
      path?: string;
      line?: number;
      side?: string;
      lineText?: string;
      fileContent?: string;
      recordedStep?: string;
      messages?: unknown;
    };
    const { fullName } = parseRepo(input.repo ?? null);
    const number = parsePullNumber(input.number);
    const path = parsePath(input.path);
    const line = Number(input.line);
    if (!Number.isInteger(line) || line <= 0) throw new Error("A valid line number is required.");
    const side = input.side === "LEFT" ? "LEFT" : "RIGHT";
    const history = parseHistory(input.messages);
    const model = input.model?.trim() || defaultReviewerModel();
    const [pull, diffResponse] = await Promise.all([
      githubJson<{
        title: string;
        base: { sha: string; repo: { full_name: string } };
        head: { sha: string; repo: { full_name: string } | null };
      }>(token, `/repos/${fullName}/pulls/${number}`),
      githubFetch(token, `/repos/${fullName}/pulls/${number}`, { headers: { Accept: "application/vnd.github.v3.diff" } }),
    ]);
    if (input.headSha && pull.head.sha !== input.headSha) {
      throw new Error("This pull request changed since you opened it. Refresh it and ask again.");
    }
    const headRepo = pull.head.repo?.full_name ?? fullName;
    const raw = async (repo: string, ref: string, filePath: string) => {
      const encoded = parsePath(filePath).split("/").map(encodeURIComponent).join("/");
      const response = await githubFetch(token, `/repos/${repo}/contents/${encoded}?ref=${ref}`, {
        headers: { Accept: "application/vnd.github.raw+json" },
      });
      const text = await response.text();
      if (text.length > MAX_FILE_CHARS) throw new Error("File is too large to read.");
      return text;
    };
    let tree: Promise<string[]> | null = null;
    const fileContent = typeof input.fileContent === "string"
      ? input.fileContent.slice(0, MAX_FILE_CHARS)
      : await (side === "LEFT" ? raw(pull.base.repo.full_name, pull.base.sha, path) : raw(headRepo, pull.head.sha, path)).catch(() => null);
    const result = await answerLineQuestion({
      target: {
        repo: fullName,
        pullNumber: number,
        pullTitle: pull.title,
        ref: pull.head.sha,
        path,
        line,
        side,
        lineText: typeof input.lineText === "string" ? input.lineText.slice(0, 2_000) : "",
        fileContent,
        recordedStep: typeof input.recordedStep === "string" ? input.recordedStep.slice(0, 200) : null,
        diff: withoutRecordingDiff(await diffResponse.text()),
      },
      history,
      complete: openRouterCompletion(session.openrouter.apiKey, model),
      tools: {
        readFile: (filePath) => raw(headRepo, pull.head.sha, filePath),
        listFiles: async (prefix) => {
          tree ??= githubJson<{ tree: Array<{ path: string; type: string }> }>(token, `/repos/${headRepo}/git/trees/${pull.head.sha}?recursive=1`)
            .then((body) => body.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
          return (await tree).filter((file) => file.startsWith(prefix));
        },
        searchCode: async (query) => {
          const q = `${query.replace(/[\r\n]+/g, " ").slice(0, 200)} repo:${fullName}`;
          const body = await githubJson<{ items: Array<{ path: string; text_matches?: Array<{ fragment: string }> }> }>(
            token,
            `/search/code?${new URLSearchParams({ q, per_page: "20" })}`,
            { headers: { Accept: "application/vnd.github.text-match+json" } }
          );
          return body.items.map((item) => ({ path: item.path, fragments: (item.text_matches ?? []).map((match) => match.fragment) }));
        },
      },
    });
    return Response.json({ ...result, model });
  } catch (error) {
    return jsonError(error);
  }
}

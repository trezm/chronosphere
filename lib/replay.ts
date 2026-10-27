import { changedLines, normalizeReplayChunks, parseUnifiedDiff, type RawReplayChunk } from "./diff";
import { normalizeReplayTree } from "./replay-tree";
import { defaultOpenRouterModel } from "./config";
import { OpenRouterError, openRouterError, type OpenRouterErrorPayload, readOpenRouterContent } from "./replay-stream";
import type { PullRequestDetail, ReplayResult } from "./types";

const MAX_LISTING_CHARS = 280_000;

/** How steps cover the numbered lines; shared by the linear and tree prompts. */
const COVERAGE_RULES = `- A step is a list of ranges. Each range must be one contiguous [start, end] run of numbered lines within a single file, but one step may hold several ranges from different files when they are one unit of work: a trait or interface together with its implementation, a type together with the code that first uses it, a function together with its test. Do not combine unrelated changes just because they are small.
- Never split a statement or block just to fit a size target.
- Cover every numbered line exactly once across all ranges: no gaps and no overlaps.
- Deleted lines are numbered too and belong with the step that removes or replaces them.
- Narrate what the code does in plain language. Do not review, judge, or invent intent.
- Mark only the few most consequential steps as impactful: steps that establish a central behavior or contract, affect many downstream callers, or carry notable correctness or security consequences. Most steps should be false.`;

const SYSTEM_PROMPT = `You reconstruct how a pull request might have been written so a reviewer can watch the work land step by step instead of reading one wall of diff.

Divide every numbered changed line into coherent steps and order them as a plausible implementation sequence: foundations and types first, then core logic, then callers and UI, then tests and documentation. The real order is unknown; choose the order that is easiest to understand.

Rules:
- Prefer fewer, larger steps. Each step should be a complete unit of work a reviewer can hold in their head — typically 50–250 changed lines in total, and never much more than 250; past that a step becomes mentally heavy.
- Do not fragment the diff into a long run of tiny steps: fold small mechanical changes (imports, renames, wiring, config) into the step they support rather than giving each its own step. A step may fall below the range only when the whole diff is small or a change genuinely stands alone.
${COVERAGE_RULES}
- Return only JSON matching: {"chunks":[{"ranges":[{"start":1,"end":3},{"start":40,"end":52}],"title":"Short title","description":"One or two sentences.","impactful":true}]}`;

const TREE_SYSTEM_PROMPT = `You reconstruct a pull request as a dependency tree of changes so a reviewer can start from self-contained building blocks and work up to the code that ties them together, instead of reading one wall of diff.

Divide every numbered changed line into nodes (steps). Leaves are the simplest changes that rely on nothing else in this pull request: a new model or type, a schema or migration, a pure helper function, a constant or config entry. A parent node is a change that relies on its children: a service that uses the model and the schema, a handler that calls the service, a component that renders what the handler returns. The root is the change that ties the work together, usually the entry point, the wiring, or the feature's top-level caller.

Rules:
- Every node has a short unique "id" and a "parent": the id of the node that relies on it, or null for the root. Aim for a single root; use several only when the pull request holds genuinely unrelated work.
- Each node has exactly one parent. When several nodes rely on the same change, choose the one that relies on it most directly.
- A child must not rely on its parent or on anything above it. If two changes rely on each other, they belong in one node.
- A node is one building block a reviewer can hold in their head — typically 20–200 changed lines. Prefer one node per real building block over one node per file, and fold imports, renames and wiring into the node they support. A tree two to four levels deep is usually right; do not chain single-child nodes just to add depth.
- Tests and documentation belong with the node they cover, or in a node of their own whose parent is the node they exercise.
${COVERAGE_RULES}
- The description says what the node does and what it provides to the node above it.
- Return only JSON matching: {"nodes":[{"id":"user-model","parent":"user-service","ranges":[{"start":1,"end":3},{"start":40,"end":52}],"title":"Short title","description":"One or two sentences.","impactful":false}]}`;

function listing(diff: string): { text: string; truncated: boolean } {
  const files = parseUnifiedDiff(diff);
  let output = "";
  let truncated = false;
  for (const file of files) {
    const header = `\n== ${file.path} (${file.status})\n`;
    if (output.length + header.length > MAX_LISTING_CHARS) {
      truncated = true;
      break;
    }
    output += header;
    for (const hunk of file.hunks) {
      const lines = [hunk.header, ...hunk.lines.map((line) => {
        if (line.type === "context") return `       ${line.text}`;
        return `[${line.changedIndex}] ${line.type === "add" ? "+" : "-"} ${line.text}`;
      })];
      for (const line of lines) {
        if (output.length + line.length + 1 > MAX_LISTING_CHARS) {
          truncated = true;
          break;
        }
        output += `${line}\n`;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { text: output.trim(), truncated };
}

/** Longest slice of model output kept when reporting unparseable JSON. */
const OUTPUT_SNIPPET_CHARS = 400;

/** Thrown when the model's output is not the JSON the prompt asked for. */
export class ReplayOutputError extends Error {
  constructor(message: string, readonly output: string, readonly cause?: unknown) {
    super(message);
    this.name = "ReplayOutputError";
  }

  /** Head and tail of the offending output, for logs. */
  snippet(): string {
    if (this.output.length <= OUTPUT_SNIPPET_CHARS) return this.output;
    const half = OUTPUT_SNIPPET_CHARS / 2;
    return `${this.output.slice(0, half)} … ${this.output.slice(-half)}`;
  }
}

function parseModelJson(content: string): { chunks?: unknown[]; nodes?: unknown[] } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate) as { chunks?: unknown[]; nodes?: unknown[] };
  } catch (cause) {
    throw new ReplayOutputError("The model returned a replay that was not valid JSON.", content, cause);
  }
}

export interface BuildReplayOptions {
  /** OpenRouter model slug; falls back to the configured default. */
  model?: string;
  /** "tree" asks for a dependency tree of steps instead of a linear sequence. */
  layout?: "tree";
  /** Aborts the model call when the caller goes away. */
  signal?: AbortSignal;
  /** Called with the accumulated model output length as content streams in. */
  onProgress?: (chars: number) => void;
  /** Called once the model output is complete and the steps are being ordered. */
  onParse?: () => void;
}

export async function buildReplay(
  detail: Pick<PullRequestDetail, "number" | "title" | "body" | "author" | "base" | "head" | "diff">,
  apiKey: string,
  options: BuildReplayOptions = {}
): Promise<ReplayResult> {
  const files = parseUnifiedDiff(detail.diff);
  const total = changedLines(files).length;
  if (total === 0) throw new Error("This pull request has no textual changes to replay.");
  const numbered = listing(detail.diff);
  const model = options.model?.trim() || defaultOpenRouterModel();
  const tree = options.layout === "tree";
  const prompt = `PR #${detail.number}: ${detail.title}\nBase: ${detail.base}  Head: ${detail.head}  Author: @${detail.author.login}\n\nDescription:\n${detail.body || "(no description)"}\n\nChanged lines, numbered:\n${numbered.text}`;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Chronosphere",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      stream: true,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: tree ? TREE_SYSTEM_PROMPT : SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  const generationId = response.headers.get("x-generation-id") ?? undefined;
  if (!response.ok) {
    // OpenRouter reports bad models and bad keys as a JSON body, streaming or
    // not; when the body is not JSON, keep it raw so the log still shows it.
    const text = await response.text().catch(() => "");
    let payload: OpenRouterErrorPayload | null = null;
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      payload = null;
    }
    const details = { status: response.status, generationId, raw: payload ? undefined : text.trim() || undefined };
    throw openRouterError(payload, details) ?? new OpenRouterError(undefined, details);
  }
  if (!response.body) throw new OpenRouterError("OpenRouter returned an empty replay.", { generationId });
  try {
    let content = "";
    for await (const delta of readOpenRouterContent(response.body)) {
      content += delta;
      options.onProgress?.(content.length);
    }
    if (!content) throw new OpenRouterError("OpenRouter returned an empty replay.", { generationId });
    options.onParse?.();
    const parsed = parseModelJson(content);
    const raw = (parsed.nodes ?? parsed.chunks ?? []) as RawReplayChunk[];
    const chunks = tree ? normalizeReplayTree(raw, files) : normalizeReplayChunks(raw, files);
    if (!chunks.length) throw new ReplayOutputError("The model did not return any usable replay steps.", content);
    return { model, chunks, truncated: numbered.truncated, ...(tree ? { layout: "tree" as const } : {}) };
  } catch (error) {
    // Anything that fails after the model call started belongs to this generation.
    if (error instanceof Error && !(error as { generationId?: string }).generationId) Object.assign(error, { generationId });
    throw error;
  }
}

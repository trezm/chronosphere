import { parseUnifiedDiff } from "./diff";
import { cleanReviewText, normalizeFindings, normalizeScout } from "./ai-review-normalize";
import type {
  AiReviewResult,
  PullRequestDetail,
} from "./types";

const MAX_PROMPT_DIFF_CHARS = 400_000;

const SCOUT_SYSTEM = `You are the SCOUT in a two-stage AI code review.
Your job is cheap, fast triage — not a deep review. Read the pull request diff and decide which parts deserve a careful look and why. Be concise. Do not report style nits or speculative concerns.

Return only JSON matching this shape:
{"intent":"One short paragraph","focus_areas":[{"file":"path/in/diff","reason":"Why it needs attention","risk":"high|medium|low"}]}`;

const REVIEWER_SYSTEM = `You are the REVIEWER in a two-stage AI code review.
A scout has already triaged this pull request. Produce only high-confidence, actionable findings: real bugs, security issues, correctness problems, resource or performance issues, missing tests for risky logic, and genuine design concerns. Skip style nits and anything speculative. If there are no real issues, return an empty findings array.

Report every finding you are confident in. For each finding, line is your best guess of the affected line number in the NEW version of the file, and file must exactly match a path in the diff.

Return only JSON matching this shape:
{"summary":"Concise overall assessment","findings":[{"file":"path/in/diff","line":1,"severity":"critical|high|medium|low","category":"bug|security|performance|correctness|design|test","title":"Short title","description":"What is wrong and why it matters","suggestion":"How to address it"}]}`;

type Detail = Pick<PullRequestDetail, "number" | "title" | "body" | "author" | "base" | "head" | "diff">;

function parseModelJson(content: string): Record<string, unknown> {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  const candidate = fenced ?? (start >= 0 && end >= start ? content.slice(start, end + 1) : content);
  return JSON.parse(candidate) as Record<string, unknown>;
}

async function completeJson(input: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
}): Promise<Record<string, unknown>> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "Chronosphere",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
    }),
  });
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message || `OpenRouter returned ${response.status}.`);
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned an empty review response.");
  return parseModelJson(content);
}

function promptSection(repo: string, detail: Detail, diff: string): string {
  return `PR #${detail.number}: ${detail.title}
Repository: ${repo}
Base: ${detail.base}   Head: ${detail.head}   Author: @${detail.author.login}

Description:
${detail.body || "(no description)"}

Unified diff:
${diff}`;
}

export async function buildAiReview(input: {
  repo: string;
  detail: Detail;
  apiKey: string;
  scoutModel: string;
  reviewerModel: string;
}): Promise<AiReviewResult> {
  const files = parseUnifiedDiff(input.detail.diff);
  const paths = new Set(files.map((file) => file.path));
  if (!paths.size) throw new Error("This pull request has no textual changes to review.");
  const truncated = input.detail.diff.length > MAX_PROMPT_DIFF_CHARS;
  const diff = truncated
    ? `${input.detail.diff.slice(0, MAX_PROMPT_DIFF_CHARS)}\n\n[diff truncated — too large to send in full]`
    : input.detail.diff;
  const pullRequest = promptSection(input.repo, input.detail, diff);
  const scoutRaw = await completeJson({
    apiKey: input.apiKey,
    model: input.scoutModel,
    system: SCOUT_SYSTEM,
    prompt: pullRequest,
  });
  const scout = normalizeScout(scoutRaw, paths);
  const reviewRaw = await completeJson({
    apiKey: input.apiKey,
    model: input.reviewerModel,
    system: REVIEWER_SYSTEM,
    prompt: `Scout triage:\n${JSON.stringify(scout, null, 2)}\n\n${pullRequest}`,
  });
  return {
    scoutModel: input.scoutModel,
    reviewerModel: input.reviewerModel,
    scout,
    summary: cleanReviewText(reviewRaw.summary),
    findings: normalizeFindings(reviewRaw.findings, paths),
    truncated,
  };
}

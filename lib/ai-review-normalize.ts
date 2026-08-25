import type {
  FindingCategory,
  FindingSeverity,
  ReviewFinding,
  RiskLevel,
  ScoutResult,
} from "./types";

const SEVERITIES = new Set<FindingSeverity>(["critical", "high", "medium", "low"]);
const CATEGORIES = new Set<FindingCategory>(["bug", "security", "performance", "correctness", "design", "test"]);
const RISKS = new Set<RiskLevel>(["high", "medium", "low"]);

export function cleanReviewText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeScout(value: Record<string, unknown>, paths: ReadonlySet<string>): ScoutResult {
  const rawAreas = Array.isArray(value.focus_areas) ? value.focus_areas : [];
  return {
    intent: cleanReviewText(value.intent),
    focusAreas: rawAreas.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const area = entry as Record<string, unknown>;
      const file = cleanReviewText(area.file);
      const risk = cleanReviewText(area.risk) as RiskLevel;
      if (!paths.has(file) || !RISKS.has(risk)) return [];
      return [{ file, reason: cleanReviewText(area.reason), risk }];
    }),
  };
}

export function normalizeFindings(value: unknown, paths: ReadonlySet<string>): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const finding = entry as Record<string, unknown>;
    const file = cleanReviewText(finding.file);
    const line = Math.floor(Number(finding.line));
    const severity = cleanReviewText(finding.severity) as FindingSeverity;
    const category = cleanReviewText(finding.category) as FindingCategory;
    if (!paths.has(file) || !Number.isFinite(line) || line < 1 || !SEVERITIES.has(severity) || !CATEGORIES.has(category)) return [];
    return [{
      file,
      line,
      severity,
      category,
      title: cleanReviewText(finding.title),
      description: cleanReviewText(finding.description),
      suggestion: cleanReviewText(finding.suggestion),
    }];
  });
}

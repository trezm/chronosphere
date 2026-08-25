export const FALLBACK_OPENROUTER_MODEL = "openai/gpt-5-mini";

export function defaultOpenRouterModel(): string {
  return process.env.OPENROUTER_MODEL?.trim() || FALLBACK_OPENROUTER_MODEL;
}

export function defaultScoutModel(): string {
  return process.env.OPENROUTER_SCOUT_MODEL?.trim() || defaultOpenRouterModel();
}

export function defaultReviewerModel(): string {
  return process.env.OPENROUTER_REVIEWER_MODEL?.trim() || defaultOpenRouterModel();
}

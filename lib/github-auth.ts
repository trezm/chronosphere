import type { SessionData } from "./session";

export type GithubSession = NonNullable<SessionData["github"]>;

/** Tokens this close to expiry are refreshed ahead of time so an in-flight request never straddles the deadline. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface GithubAuthOptions {
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type GithubSessionCheck =
  | { status: "absent"; github: undefined; changed: false }
  | { status: "valid"; github: GithubSession; changed: boolean }
  | { status: "expired"; github: undefined; changed: true };

type RefreshOutcome = { ok: true; github: GithubSession } | { ok: false; permanent: boolean };

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export function isExpired(github: GithubSession, now: number): boolean {
  return github.expiresAt !== undefined && github.expiresAt <= now;
}

export function isExpiringSoon(github: GithubSession, now: number): boolean {
  return github.expiresAt !== undefined && github.expiresAt - now < REFRESH_MARGIN_MS;
}

/**
 * Exchanges the refresh token for a new access token. GitHub rotates the refresh
 * token on every use, so the returned session must replace the stored one.
 */
export async function refreshGithubToken(github: GithubSession, options: GithubAuthOptions = {}): Promise<RefreshOutcome> {
  const { clientId, clientSecret, fetch: fetchImpl = fetch, now = Date.now } = options;
  if (!github.refreshToken || !clientId || !clientSecret) return { ok: false, permanent: true };
  let token: TokenResponse;
  try {
    const response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: github.refreshToken }),
    });
    if (response.status >= 500) return { ok: false, permanent: false };
    token = (await response.json()) as TokenResponse;
  } catch {
    return { ok: false, permanent: false };
  }
  if (!token.access_token) return { ok: false, permanent: true };
  return {
    ok: true,
    github: {
      ...github,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? github.refreshToken,
      expiresAt: token.expires_in ? now() + token.expires_in * 1000 : undefined,
    },
  };
}

async function tokenStatus(github: GithubSession, fetchImpl: typeof fetch): Promise<"valid" | "rejected" | "unknown"> {
  try {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${github.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "chronosphere",
      },
    });
    if (response.ok) return "valid";
    return response.status === 401 ? "rejected" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Decides whether a stored GitHub session can still be used. An expiring or
 * expired token is refreshed; anything else is checked against GitHub so a
 * revoked token surfaces now rather than on the next repository request.
 * Transient failures keep the current session: only GitHub's own rejection
 * signs the user out.
 */
export async function ensureGithubSession(github: GithubSession | undefined, options: GithubAuthOptions = {}): Promise<GithubSessionCheck> {
  if (!github) return { status: "absent", github: undefined, changed: false };
  const { fetch: fetchImpl = fetch, now = Date.now } = options;
  const expired: GithubSessionCheck = { status: "expired", github: undefined, changed: true };
  let refreshAttempted = false;

  if (isExpiringSoon(github, now())) {
    refreshAttempted = true;
    const refreshed = await refreshGithubToken(github, options);
    if (refreshed.ok) return { status: "valid", github: refreshed.github, changed: true };
    if (isExpired(github, now())) return expired;
  }

  const status = await tokenStatus(github, fetchImpl);
  if (status !== "rejected") return { status: "valid", github, changed: false };
  if (!refreshAttempted) {
    const refreshed = await refreshGithubToken(github, options);
    if (refreshed.ok) return { status: "valid", github: refreshed.github, changed: true };
  }
  return expired;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const SESSION_URL = "/api/auth/session";
const expiredListeners = new Set<() => void>();
let recovery: Promise<boolean> | null = null;

/** Registers a listener for the moment the GitHub session cannot be refreshed and the user has to reconnect. */
export function onGithubSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener);
  return () => { expiredListeners.delete(listener); };
}

/**
 * Asks the server to refresh or validate the GitHub session. Concurrent 401s
 * share one check so a burst of failing requests refreshes the token once.
 */
function recoverGithubSession(): Promise<boolean> {
  recovery ??= fetch(SESSION_URL, { cache: "no-store" })
    .then(async (response) => response.ok && Boolean(((await response.json()) as { github?: { connected?: boolean } }).github?.connected))
    .catch(() => false)
    .finally(() => { recovery = null; });
  return recovery;
}

/**
 * fetch() that treats a 401 as a possibly expired GitHub token: the session is
 * refreshed and the request retried once. When GitHub itself rejects the
 * session, the expired listeners fire so the app can return to the connect page.
 */
export async function authorizedFetch(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== 401 || url.startsWith("/api/auth/")) return response;
  if (await recoverGithubSession()) return fetch(url, init);
  for (const listener of expiredListeners) listener();
  return response;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authorizedFetch(url, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(body.error || `${response.status} ${response.statusText}`, response.status);
  }
  return body;
}

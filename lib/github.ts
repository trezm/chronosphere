import type { NextRequest } from "next/server";
import { readSession } from "./session";

const API = "https://api.github.com";

export async function githubToken(request: NextRequest): Promise<string> {
  const session = await readSession(request);
  if (!session.github?.accessToken) throw new Error("GitHub authentication is required.");
  return session.github.accessToken;
}

export async function githubFetch(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "chronosphere",
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string; errors?: unknown[] };
      message = body.message || message;
      if (body.errors?.length) message += `: ${JSON.stringify(body.errors)}`;
    } catch {
      // Keep the status line for non-JSON failures.
    }
    throw new Error(`GitHub: ${message}`);
  }
  return response;
}

export async function githubJson<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  return (await (await githubFetch(token, path, init)).json()) as T;
}

export function parseRepo(value: string | null): { owner: string; repo: string; fullName: string } {
  const [owner, repo, ...rest] = (value ?? "").split("/");
  if (!owner || !repo || rest.length > 0 || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new Error("A valid owner/repository is required.");
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function parsePullNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error("A valid pull request number is required.");
  return number;
}

export function jsonError(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const auth = /authentication is required/i.test(message);
  return Response.json({ error: message }, { status: auth ? 401 : status });
}

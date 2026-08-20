import { NextRequest } from "next/server";
import { githubFetch, githubToken, jsonError, parseRepo } from "@/lib/github";

const MAX_CONTEXT_FILE_CHARS = 4_000_000;

function parsePath(value: string | null): string {
  const path = value?.trim() ?? "";
  const segments = path.split("/");
  if (!path || path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("A valid repository file path is required.");
  }
  return segments.map(encodeURIComponent).join("/");
}

export async function GET(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const { fullName } = parseRepo(request.nextUrl.searchParams.get("repo"));
    const ref = request.nextUrl.searchParams.get("ref")?.trim() ?? "";
    if (!/^[0-9a-f]{40}$/i.test(ref)) throw new Error("A valid commit SHA is required.");
    const path = parsePath(request.nextUrl.searchParams.get("path"));
    const response = await githubFetch(token, `/repos/${fullName}/contents/${path}?ref=${ref}`, {
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    const content = await response.text();
    if (content.length > MAX_CONTEXT_FILE_CHARS) throw new Error("This file is too large to expand inline.");
    return Response.json({ content });
  } catch (error) {
    return jsonError(error);
  }
}

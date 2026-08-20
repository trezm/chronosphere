import { NextRequest, NextResponse } from "next/server";
import {
  appOrigin,
  clearTransaction,
  readSession,
  readTransaction,
  writeSession,
} from "@/lib/session";

export async function GET(request: NextRequest) {
  const transaction = await readTransaction(request);
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!transaction || transaction.provider !== "github" || !code || !state || state !== transaction.state) {
    return NextResponse.redirect(new URL("/?error=GitHub+authorization+could+not+be+verified", request.url));
  }
  try {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        code_verifier: transaction.verifier,
        redirect_uri: `${appOrigin(request)}/api/auth/github/callback`,
      }),
    });
    const token = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!response.ok || !token.access_token) throw new Error(token.error_description || "GitHub did not return an access token.");
    const viewerResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "chronosphere",
      },
    });
    const viewer = (await viewerResponse.json()) as {
      login?: string;
      name?: string | null;
      avatar_url?: string;
      message?: string;
    };
    if (!viewerResponse.ok || !viewer.login) throw new Error(viewer.message || "GitHub user lookup failed.");
    const session = await readSession(request);
    session.github = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      login: viewer.login,
      name: viewer.name ?? null,
      avatarUrl: viewer.avatar_url ?? "",
    };
    const redirect = NextResponse.redirect(new URL("/", request.url));
    await writeSession(request, redirect, session);
    clearTransaction(request, redirect);
    return redirect;
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub authorization failed.";
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(message)}`, request.url));
  }
}

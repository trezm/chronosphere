import { NextRequest, NextResponse } from "next/server";
import { appOrigin, codeChallenge, randomToken, writeTransaction } from "@/lib/session";

export async function GET(request: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(new URL("/?error=GitHub+OAuth+is+not+configured", request.url));
  }
  const state = randomToken();
  const verifier = randomToken(48);
  const callback = `${appOrigin(request)}/api/auth/github/callback`;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("scope", "repo read:org");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  const response = NextResponse.redirect(url);
  await writeTransaction(request, response, {
    provider: "github",
    state,
    verifier,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return response;
}

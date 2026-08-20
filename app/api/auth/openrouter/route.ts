import { NextRequest, NextResponse } from "next/server";
import { appOrigin, codeChallenge, randomToken, writeTransaction } from "@/lib/session";

export async function GET(request: NextRequest) {
  const verifier = randomToken(48);
  const callback = `${appOrigin(request)}/api/auth/openrouter/callback`;
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", await codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  const response = NextResponse.redirect(url);
  await writeTransaction(request, response, {
    provider: "openrouter",
    verifier,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return response;
}

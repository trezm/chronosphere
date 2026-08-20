import { NextRequest, NextResponse } from "next/server";
import { clearTransaction, readSession, readTransaction, writeSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const transaction = await readTransaction(request);
  const code = request.nextUrl.searchParams.get("code");
  if (!transaction || transaction.provider !== "openrouter" || !code) {
    return NextResponse.redirect(new URL("/?error=OpenRouter+authorization+could+not+be+verified", request.url));
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: transaction.verifier,
        code_challenge_method: "S256",
      }),
    });
    const token = (await response.json()) as { key?: string; user_id?: string | null; error?: { message?: string } };
    if (!response.ok || !token.key) throw new Error(token.error?.message || "OpenRouter did not return an API key.");
    const session = await readSession(request);
    session.openrouter = { apiKey: token.key, userId: token.user_id ?? null };
    const redirect = NextResponse.redirect(new URL("/", request.url));
    await writeSession(request, redirect, session);
    clearTransaction(request, redirect);
    return redirect;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenRouter authorization failed.";
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(message)}`, request.url));
  }
}

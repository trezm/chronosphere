import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";

export interface SessionData {
  github?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    login: string;
    name: string | null;
    avatarUrl: string;
  };
  openrouter?: {
    apiKey: string;
    userId: string | null;
  };
}

interface OAuthTransaction {
  provider: "github" | "openrouter";
  state?: string;
  verifier: string;
  expiresAt: number;
}

const SESSION_COOKIE = "chronosphere_session";
const TRANSACTION_COOKIE = "chronosphere_oauth";

function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return "chronosphere-local-development-secret-change-me";
}

async function key(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret()));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function seal(value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), plaintext);
  return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

async function unseal<T>(value: string | undefined): Promise<T | null> {
  if (!value) return null;
  try {
    const [iv, body] = value.split(".");
    if (!iv || !body) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
      await key(),
      Buffer.from(body, "base64url")
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

function cookieOptions(request: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:" || process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export async function readSession(request: NextRequest): Promise<SessionData> {
  return (await unseal<SessionData>(request.cookies.get(SESSION_COOKIE)?.value)) ?? {};
}

export async function writeSession(
  request: NextRequest,
  response: NextResponse,
  session: SessionData
): Promise<void> {
  response.cookies.set(SESSION_COOKIE, await seal(session), cookieOptions(request, 60 * 60 * 24 * 30));
}

export function clearSession(request: NextRequest, response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(request, 0));
  response.cookies.set(TRANSACTION_COOKIE, "", cookieOptions(request, 0));
}

export async function writeTransaction(
  request: NextRequest,
  response: NextResponse,
  transaction: OAuthTransaction
): Promise<void> {
  response.cookies.set(TRANSACTION_COOKIE, await seal(transaction), cookieOptions(request, 60 * 10));
}

export async function readTransaction(request: NextRequest): Promise<OAuthTransaction | null> {
  const transaction = await unseal<OAuthTransaction>(request.cookies.get(TRANSACTION_COOKIE)?.value);
  if (!transaction || transaction.expiresAt < Date.now()) return null;
  return transaction;
}

export function clearTransaction(request: NextRequest, response: NextResponse): void {
  response.cookies.set(TRANSACTION_COOKIE, "", cookieOptions(request, 0));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function appOrigin(request: NextRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0] || request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0] || request.headers.get("host");
  return host ? `${proto}://${host}` : request.nextUrl.origin;
}

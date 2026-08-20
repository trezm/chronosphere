import { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { clearSession } from "@/lib/session";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  clearSession(request, response);
  return response;
}

import { NextRequest, NextResponse } from "next/server";
import { defaultOpenRouterModel, defaultReviewerModel, defaultScoutModel } from "@/lib/config";
import { ensureGithubSession } from "@/lib/github-auth";
import { readSession, writeSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const session = await readSession(request);
  const check = await ensureGithubSession(session.github, {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  });
  const github = check.github;
  const response = NextResponse.json({
    github: github
      ? {
          connected: true,
          user: {
            login: github.login,
            name: github.name,
            avatarUrl: github.avatarUrl,
          },
        }
      : { connected: false, user: null, expired: check.status === "expired" },
    openrouter: {
      connected: Boolean(session.openrouter?.apiKey),
      userId: session.openrouter?.userId ?? null,
    },
    configured: {
      github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    },
    defaults: {
      model: defaultOpenRouterModel(),
      scoutModel: defaultScoutModel(),
      reviewerModel: defaultReviewerModel(),
    },
  }, { headers: { "Cache-Control": "no-store" } });
  // A refreshed token or a rejected one both change the cookie; an unchanged
  // session is left alone so the check itself never extends its lifetime.
  if (check.changed) await writeSession(request, response, { ...session, github });
  return response;
}

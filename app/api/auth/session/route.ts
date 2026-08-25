import { NextRequest } from "next/server";
import { defaultOpenRouterModel, defaultReviewerModel, defaultScoutModel } from "@/lib/config";
import { readSession } from "@/lib/session";

export async function GET(request: NextRequest) {
  const session = await readSession(request);
  return Response.json({
    github: session.github
      ? {
          connected: true,
          user: {
            login: session.github.login,
            name: session.github.name,
            avatarUrl: session.github.avatarUrl,
          },
        }
      : { connected: false, user: null },
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
  });
}

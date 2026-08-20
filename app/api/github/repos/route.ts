import { NextRequest } from "next/server";
import { githubJson, githubToken, jsonError } from "@/lib/github";
import type { Repository } from "@/lib/types";

interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  owner: { login: string; avatar_url: string };
}

export async function GET(request: NextRequest) {
  try {
    const token = await githubToken(request);
    const repos = await githubJson<GitHubRepo[]>(
      token,
      "/user/repos?per_page=100&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member"
    );
    const result: Repository[] = repos.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner.login,
      ownerAvatarUrl: repo.owner.avatar_url,
      private: repo.private,
      description: repo.description,
      updatedAt: repo.updated_at,
    }));
    return Response.json({ repositories: result });
  } catch (error) {
    return jsonError(error);
  }
}

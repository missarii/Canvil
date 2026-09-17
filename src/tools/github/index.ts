/**
 * GitHub tools.
 *
 * GitHub is used to understand *patterns and API usage*, never to copy code
 * blindly: the agent is instructed to derive its own implementation for the
 * user's project. Read endpoints (search, file inspection, releases) are used
 * for research; the `github_create_repository` tool lets Canvil scaffold a new
 * repository when a task explicitly asks for one.
 *
 * Without GITHUB_TOKEN the public API allows 60 requests/hour, which is enough
 * for a single run but not for a research-heavy one — the tools surface that
 * limit instead of failing mysteriously.
 */

import { z } from "zod";
import { defineTool } from "../types.js";
import type { ToolContext } from "../types.js";
import { ExternalServiceError } from "../../util/errors.js";
import { fetchText, isSuccessStatus, parseJsonBody } from "../../util/http.js";
import { truncate } from "../../util/text.js";

const API_ROOT = "https://api.github.com";

export interface GitHubRequestOptions {
  context: ToolContext;
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Media type; code search needs the text-match variant. */
  accept?: string;
  /** HTTP method; defaults to GET. POST/PUT when creating or updating resources. */
  method?: "GET" | "POST" | "PUT";
  /** JSON body for POST/PUT/PATCH; serialized with the correct content-type. */
  body?: unknown;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  authenticated: boolean;
}

/** Perform a GitHub REST request with auth (when available) and clear errors. */
export async function githubRequest<T>(options: GitHubRequestOptions): Promise<GitHubResponse<T>> {
  const { context } = options;
  const url = new URL(`${API_ROOT}${options.path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

    const headers: Record<string, string> = {
    accept: options.accept ?? "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (context.env.githubToken) {
    headers.authorization = `Bearer ${context.env.githubToken}`;
  }

  const hasBody = options.body !== undefined;
  if (hasBody) {
    headers["content-type"] = "application/json";
  }

  const result = await fetchText(context.fetchImpl, url.toString(), {
    method: options.method ?? "GET",
    timeoutMs: context.config.limits.requestTimeoutMs,
    maxBytes: context.config.limits.maxFetchBytes,
    userAgent: context.config.limits.userAgent,
    headers,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });

  if (result.status === 403 || result.status === 429) {
    throw new ExternalServiceError(
      `GitHub rate limit reached (HTTP ${result.status}). Set GITHUB_TOKEN to raise the limit from 60 to 5000 requests/hour.`,
      "github",
    );
  }
  if (!isSuccessStatus(result.status)) {
    throw new ExternalServiceError(
      `GitHub returned HTTP ${result.status} for ${options.path}: ${result.body.slice(0, 300)}`,
      "github",
    );
  }

  return {
    status: result.status,
    data: parseJsonBody<T>(result, "GitHub"),
    authenticated: Boolean(context.env.githubToken),
  };
}

export interface GitHubRepositorySummary {
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  url: string;
  updatedAt: string;
  archived: boolean;
  isFork: boolean;
}

export const githubSearchRepositoriesTool = defineTool({
  name: "github_search_repositories",
  description:
    "Search GitHub repositories to find official or widely used example implementations of a pattern.",
  effect: "network",
  schema: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(30).optional(),
    sort: z.enum(["stars", "updated", "best-match"]).optional(),
  }),
  async execute(input, context) {
    const response = await githubRequest<{
      items?: Array<{
        full_name?: string;
        description?: string | null;
        stargazers_count?: number;
        language?: string | null;
        html_url?: string;
        updated_at?: string;
        archived?: boolean;
        fork?: boolean;
      }>;
    }>({
      context,
      path: "/search/repositories",
      query: {
        q: input.query,
        per_page: input.limit ?? 8,
        sort: input.sort === "best-match" ? undefined : (input.sort ?? "stars"),
      },
    });

    const repositories: GitHubRepositorySummary[] = (response.data.items ?? [])
      .filter((item) => typeof item.full_name === "string")
      .map((item) => ({
        fullName: item.full_name ?? "",
        description: item.description ?? null,
        stars: item.stargazers_count ?? 0,
        language: item.language ?? null,
        url: item.html_url ?? `https://github.com/${item.full_name}`,
        updatedAt: item.updated_at ?? "",
        archived: item.archived === true,
        isFork: item.fork === true,
      }));

    return { authenticated: response.authenticated, query: input.query, repositories };
  },
});

export const githubReadFileTool = defineTool({
  name: "github_read_file",
  description:
    "Read a file from a GitHub repository (README, example source, config) by owner/name and path.",
  effect: "network",
  schema: z.object({
    repository: z.string().min(3).describe("owner/name"),
    path: z.string().min(1).describe("File path inside the repository"),
    ref: z.string().optional().describe("Branch, tag or commit SHA"),
    maxChars: z.number().int().min(500).max(80_000).optional(),
  }),
  async execute(input, context) {
    const slash = input.repository.indexOf("/");
    const owner = slash > 0 ? input.repository.slice(0, slash) : "";
    const name = slash > 0 ? input.repository.slice(slash + 1) : "";
    if (!owner || !name) {
      throw new ExternalServiceError(
        `repository must be in owner/name form, received "${input.repository}"`,
        "github",
      );
    }

    const encodedPath = input.path
      .split("/")
      .filter((part) => part.length > 0)
      .map(encodeURIComponent)
      .join("/");

    const response = await githubRequest<{ content?: string; encoding?: string; size?: number }>({
      context,
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}`,
      ...(input.ref ? { query: { ref: input.ref } } : {}),
    });

    const encoded = (response.data.content ?? "").replace(/\n/g, "");
    const content =
      encoded.length > 0 && response.data.encoding !== "none"
        ? Buffer.from(encoded, "base64").toString("utf8")
        : "";

    return {
      repository: input.repository,
      path: input.path,
      sizeBytes: response.data.size ?? Buffer.byteLength(content, "utf8"),
      content: truncate(content, input.maxChars ?? 20_000),
    };
  },
});

export const githubSearchCodeTool = defineTool({
  name: "github_search_code",
  description:
    "Search code across GitHub. Requires GITHUB_TOKEN, because the code search API is unavailable anonymously.",
  effect: "network",
  schema: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  async execute(input, context) {
    if (!context.env.githubToken) {
      throw new ExternalServiceError(
        "github_search_code requires GITHUB_TOKEN: anonymous code search is not supported by the GitHub API.",
        "github",
      );
    }
    const response = await githubRequest<{
      items?: Array<{
        name?: string;
        path?: string;
        html_url?: string;
        repository?: { full_name?: string };
        text_matches?: Array<{ fragment?: string }>;
      }>;
    }>({
      context,
      path: "/search/code",
      query: { q: input.query, per_page: input.limit ?? 10 },
      accept: "application/vnd.github.text-match+json",
    });

    return {
      query: input.query,
      matches: (response.data.items ?? []).map((item) => ({
        repository: item.repository?.full_name ?? "",
        path: item.path ?? item.name ?? "",
        url: item.html_url ?? "",
        fragments: (item.text_matches ?? [])
          .map((match) => match.fragment ?? "")
          .filter((fragment) => fragment.length > 0)
          .slice(0, 3),
      })),
    };
  },
});

export const githubListReleasesTool = defineTool({
  name: "github_list_releases",
  description:
    "List recent releases of a repository; useful for spotting breaking changes before an upgrade.",
  effect: "network",
  schema: z.object({
    repository: z.string().min(3).describe("owner/name"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(input, context) {
    const response = await githubRequest<
      Array<{
        tag_name?: string;
        name?: string;
        published_at?: string;
        body?: string;
        prerelease?: boolean;
      }>
    >({
      context,
      path: `/repos/${input.repository}/releases`,
      query: { per_page: input.limit ?? 5 },
    });

    const releases = Array.isArray(response.data) ? response.data : [];
        return {
      repository: input.repository,
      releases: releases.map((release) => ({
        tag: release.tag_name ?? "",
        name: release.name ?? "",
        publishedAt: release.published_at ?? "",
        prerelease: release.prerelease === true,
        notes: truncate(release.body ?? "", 4_000),
      })),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Create repository                                                          */
/* -------------------------------------------------------------------------- */

/** Result of creating a GitHub repository. */
export interface GitHubCreateResult {
  fullName: string;
  htmlUrl: string;
  sshUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  webUrl: string;
}

export const githubCreateRepositoryTool = defineTool({
  name: "github_create_repository",
  description:
    "Create a new GitHub repository under the authenticated user's account. Requires GITHUB_TOKEN. " +
    "Optionally initializes the repository with a README so it has an initial commit to push to.",
  effect: "execute",
  schema: z.object({
    name: z.string().min(1).max(100).describe("Repository name (lowercase, alphanumeric and hyphens only)"),
    description: z.string().max(500).optional().describe("Repository description (shown on GitHub)"),
    visibility: z.enum(["public", "private"]).default("public").describe("Repository visibility"),
    /** When true, GitHub creates an initial commit with a README.md so the branch exists. */
    autoInit: z.boolean().default(true).describe("Initialize with a README commit"),
    /** e.g. ".gitignore template name; ignored unless autoInit is true. */
    gitignoreTemplate: z.string().optional(),
    /** e.g. "Node" for the license template; ignored unless autoInit is true. */
    licenseTemplate: z.string().optional(),
    owner: z.string().optional().describe("Create under an organization instead of the user account"),
    homepage: z.string().url().optional(),
    issues: z.boolean().default(true).describe("Enable issues"),
    projects: z.boolean().default(false).describe("Enable projects (classic)"),
    wiki: z.boolean().default(false).describe("Enable wiki"),
    topics: z.array(z.string()).max(20).optional().describe("Repository topics (tags)"),
  }),
  async execute(input, context) {
    if (!context.env.githubToken) {
      throw new ExternalServiceError(
        "github_create_repository requires GITHUB_TOKEN to authenticate with GitHub.",
        "github",
      );
    }

    const body: Record<string, unknown> = {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      private: input.visibility === "private",
      has_issues: input.issues,
      has_projects: input.projects,
      has_wiki: input.wiki,
      auto_init: input.autoInit,
      ...(input.homepage ? { homepage: input.homepage } : {}),
      ...(input.gitignoreTemplate ? { gitignore_template: input.gitignoreTemplate } : {}),
      ...(input.licenseTemplate ? { license_template: input.licenseTemplate } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
    };

    const path = input.owner ? `/orgs/${encodeURIComponent(input.owner)}/repos` : "/user/repos";

    const response = await githubRequest<{
      full_name?: string;
      html_url?: string;
      ssh_url?: string;
      clone_url?: string;
      default_branch?: string;
      private?: boolean;
    }>({
      context,
      path,
      method: "POST",
      body,
    });

    const repoUrl = response.data.html_url ?? response.data.clone_url ?? "";
    const result: GitHubCreateResult = {
      fullName: response.data.full_name ?? input.name,
      htmlUrl: response.data.html_url ?? repoUrl,
      sshUrl: response.data.ssh_url ?? "",
      cloneUrl: response.data.clone_url ?? repoUrl,
      defaultBranch: response.data.default_branch ?? "main",
      private: response.data.private ?? false,
      webUrl: response.data.html_url ?? repoUrl,
    };

    // Apply topics via the separate topics endpoint (GitHub requires a separate call).
    if (input.topics && input.topics.length > 0) {
      const fullName = result.fullName;
      await githubRequest<{ names?: string[] }>({
        context,
        path: `/repos/${fullName}/topics`,
        method: "PUT",
        body: { names: input.topics },
        accept: "application/vnd.github.mercy-preview+json",
      });
    }

    return result;
  },
});
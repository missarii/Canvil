/**
 * Package registry intelligence.
 *
 * Structured registries beat web search for facts about a dependency: an
 * installed version, a licence, a deprecation flag. Canvil asks the registry
 * instead of having the model guess a version number.
 */

import { z } from "zod";
import { defineTool } from "../types.js";
import { ExternalServiceError } from "../../util/errors.js";
import { fetchText, isSuccessStatus, parseJsonBody } from "../../util/http.js";

export interface NpmPackageInfo {
  name: string;
  version: string;
  description: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  deprecated: boolean;
  engines: Record<string, string>;
  dependencyCount: number;
}

/** npm exposes a small per-version manifest at `/<name>/latest`. */
export async function fetchNpmPackage(
  fetchImpl: typeof fetch,
  packageName: string,
  limits: { timeoutMs: number; maxBytes: number; userAgent: string },
): Promise<NpmPackageInfo> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace(/%2F/g, "/")}/latest`;
  const result = await fetchText(fetchImpl, url, {
    timeoutMs: limits.timeoutMs,
    maxBytes: Math.min(limits.maxBytes, 200_000),
    userAgent: limits.userAgent,
    accept: ["application/json"],
  });

  if (result.status === 404) {
    throw new ExternalServiceError(`npm package not found: ${packageName}`, "npm");
  }
  if (!isSuccessStatus(result.status)) {
    throw new ExternalServiceError(
      `npm registry returned HTTP ${result.status} for ${packageName}`,
      "npm",
    );
  }

  const payload = parseJsonBody<{
    name?: string;
    version?: string;
    description?: string;
    license?: string | { type?: string };
    homepage?: string;
    repository?: { url?: string } | string;
    deprecated?: string;
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
  }>(result, "npm registry");

  const repository =
    typeof payload.repository === "string"
      ? payload.repository
      : (payload.repository?.url ?? null);
  const licence =
    typeof payload.license === "string" ? payload.license : (payload.license?.type ?? null);

  return {
    name: payload.name ?? packageName,
    version: payload.version ?? "unknown",
    description: payload.description ?? null,
    license: licence,
    homepage: payload.homepage ?? null,
    repository,
    deprecated: typeof payload.deprecated === "string" && payload.deprecated.length > 0,
    engines: payload.engines ?? {},
    dependencyCount: Object.keys(payload.dependencies ?? {}).length,
  };
}

export interface PypiPackageInfo {
  name: string;
  version: string;
  summary: string | null;
  license: string | null;
  requiresPython: string | null;
  homepage: string | null;
  yanked: boolean;
}

export async function fetchPypiPackage(
  fetchImpl: typeof fetch,
  packageName: string,
  limits: { timeoutMs: number; maxBytes: number; userAgent: string },
): Promise<PypiPackageInfo> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
  const result = await fetchText(fetchImpl, url, {
    timeoutMs: limits.timeoutMs,
    maxBytes: Math.min(limits.maxBytes, 400_000),
    userAgent: limits.userAgent,
    accept: ["application/json"],
  });

  if (result.status === 404) {
    throw new ExternalServiceError(`PyPI package not found: ${packageName}`, "pypi");
  }
  if (!isSuccessStatus(result.status)) {
    throw new ExternalServiceError(`PyPI returned HTTP ${result.status} for ${packageName}`, "pypi");
  }

  const payload = parseJsonBody<{
    info?: {
      name?: string;
      version?: string;
      summary?: string;
      license?: string;
      requires_python?: string;
      home_page?: string;
      project_url?: string;
    };
  }>(result, "PyPI");

  const info = payload.info ?? {};
  return {
    name: info.name ?? packageName,
    version: info.version ?? "unknown",
    summary: info.summary ?? null,
    license: info.license ?? null,
    requiresPython: info.requires_python ?? null,
    homepage: info.home_page ?? info.project_url ?? null,
    yanked: false,
  };
}

export const packageInfoTool = defineTool({
  name: "package_info",
  description:
    "Look up authoritative metadata (latest version, licence, deprecation, engines) for an npm or PyPI package from its registry.",
  effect: "network",
  schema: z.object({
    name: z.string().min(1).describe("Package name, e.g. next or django"),
    registry: z.enum(["npm", "pypi"]),
  }),
  async execute(input, context) {
    const limits = {
      timeoutMs: context.config.limits.requestTimeoutMs,
      maxBytes: context.config.limits.maxFetchBytes,
      userAgent: context.config.limits.userAgent,
    };
    const info =
      input.registry === "npm"
        ? await fetchNpmPackage(context.fetchImpl, input.name, limits)
        : await fetchPypiPackage(context.fetchImpl, input.name, limits);
    return { registry: input.registry, ...info };
  },
});
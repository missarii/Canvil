/**
 * Registries: technology -> documentation root, and domain -> trust tier.
 *
 * These are the "where should I look" tables. They are deliberately data, not
 * code, so they can be extended without touching the agent.
 */

import fs from "node:fs";
import { documentationRegistryPath, sourcesRegistryPath, findCanvilHome } from "./loader.js";
import { ConfigError } from "../util/errors.js";

export interface DocumentationEntry {
  key: string;
  name: string;
  documentation: string;
  aliases: string[];
}

export interface SourceTier {
  rank: number;
  label: string;
  description: string;
}

export type SourceType =
  | "project"
  | "official-docs"
  | "official-repo"
  | "standard"
  | "registry"
  | "security-authority"
  | "community"
  | "general-web";

export interface DomainRule {
  match: string;
  type: SourceType;
  technology?: string;
}

export interface SourcesRegistry {
  tiers: Record<string, SourceTier>;
  domains: DomainRule[];
  communityPatterns: string[];
}

function readJsonFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read registry ${filePath}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`Registry ${filePath} must contain a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Invalid JSON in ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Load the documentation registry. Unknown shapes degrade to an empty registry
 * rather than crashing a run, because research is best-effort.
 */
export function loadDocumentationRegistry(home: string = findCanvilHome()): Map<string, DocumentationEntry> {
  const filePath = documentationRegistryPath(home);
  if (!fs.existsSync(filePath)) return new Map();
  const raw = readJsonFile(filePath);
  const registry = new Map<string, DocumentationEntry>();
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as { name?: unknown; documentation?: unknown; aliases?: unknown };
    if (typeof entry.documentation !== "string") continue;
    const aliases = Array.isArray(entry.aliases)
      ? entry.aliases.filter((alias): alias is string => typeof alias === "string")
      : [];
    registry.set(key, {
      key,
      name: typeof entry.name === "string" ? entry.name : key,
      documentation: entry.documentation,
      aliases,
    });
  }
  return registry;
}

export function loadSourcesRegistry(home: string = findCanvilHome()): SourcesRegistry {
  const filePath = sourcesRegistryPath(home);
  if (!fs.existsSync(filePath)) {
    return { tiers: {}, domains: [], communityPatterns: [] };
  }
  const raw = readJsonFile(filePath);

  const tiers: Record<string, SourceTier> = {};
  if (raw.tiers && typeof raw.tiers === "object") {
    for (const [key, value] of Object.entries(raw.tiers as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const tier = value as { rank?: unknown; label?: unknown; description?: unknown };
      tiers[key] = {
        rank: typeof tier.rank === "number" ? tier.rank : 99,
        label: typeof tier.label === "string" ? tier.label : key,
        description: typeof tier.description === "string" ? tier.description : "",
      };
    }
  }

  const domains: DomainRule[] = [];
  if (Array.isArray(raw.domains)) {
    for (const item of raw.domains) {
      if (!item || typeof item !== "object") continue;
      const rule = item as { match?: unknown; type?: unknown; technology?: unknown };
      if (typeof rule.match !== "string" || typeof rule.type !== "string") continue;
      const domain: DomainRule = { match: rule.match.toLowerCase(), type: rule.type as SourceType };
      if (typeof rule.technology === "string") domain.technology = rule.technology;
      domains.push(domain);
    }
    // Longest match first: `github.com/advisories` beats `github.com`.
    domains.sort((a, b) => b.match.length - a.match.length);
  }

  const communityPatterns = Array.isArray(raw.communityPatterns)
    ? raw.communityPatterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];

  return { tiers, domains, communityPatterns };
}

/**
 * Map a technology identifier (package name, file extension, DB engine) to a
 * documentation entry. Handles scope prefixes (`@nestjs/core` -> `nestjs`).
 */
export function resolveDocumentation(
  registry: Map<string, DocumentationEntry>,
  technology: string,
): DocumentationEntry | undefined {
  const normalized = technology.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  const candidates = new Set<string>([normalized]);
  if (normalized.startsWith("@")) {
    const [scope, name] = normalized.split("/");
    if (scope) candidates.add(scope.replace(/^@/, ""));
    if (name) candidates.add(name);
  }
  candidates.add(normalized.replace(/^node-/, ""));

  for (const candidate of candidates) {
    const direct = registry.get(candidate);
    if (direct) return direct;
  }
  for (const entry of registry.values()) {
    if (entry.aliases.some((alias) => alias.toLowerCase() === normalized)) return entry;
  }
  return undefined;
}
/**
 * Source ranking.
 *
 * Search engines rank by popularity; Canvil ranks by authority. A three-year-old
 * Stack Overflow answer must never outrank the official docs for the same
 * question, so tier is weighted far above lexical similarity.
 */

import type { SourcesRegistry, SourceType } from "../../config/registries.js";
import type { RankedSource, ResearchSource } from "../types.js";
import { tokenize } from "../../util/text.js";

export interface ClassifyOptions {
  registry: SourcesRegistry;
  /** Hosts that belong to the user's own infrastructure (tier 1). */
  projectHosts?: string[];
}

export interface Classification {
  sourceType: SourceType;
  tier: number;
  technology?: string;
}

const TIER_OF_TYPE: Record<SourceType, number> = {
  project: 1,
  "official-docs": 2,
  "official-repo": 3,
  standard: 4,
  registry: 5,
  "security-authority": 6,
  community: 7,
  "general-web": 8,
};

/** The default tier for a source type, used when the registry omits it. */
export function tierForType(type: SourceType, registry?: SourcesRegistry): number {
  const configured = registry?.tiers?.[type]?.rank;
  if (typeof configured === "number") return configured;
  return TIER_OF_TYPE[type] ?? 8;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Classify a URL into a source type + tier using the registry's domain table.
 * Unmatched hosts are general web, except subdomains that look like personal
 * blogs, which are downgraded to community.
 */
export function classifyUrl(url: string, options: ClassifyOptions): Classification {
  const host = hostOf(url);
  if (host.length === 0) {
    return { sourceType: "general-web", tier: tierForType("general-web", options.registry) };
  }

  for (const projectHost of options.projectHosts ?? []) {
    if (host === projectHost.toLowerCase() || host.endsWith(`.${projectHost.toLowerCase()}`)) {
      return { sourceType: "project", tier: tierForType("project", options.registry) };
    }
  }

  const lowerUrl = url.toLowerCase();
  for (const rule of options.registry.domains) {
    const matchesHost = host === rule.match || host.endsWith(`.${rule.match}`);
    const matchesPath = rule.match.includes("/") && lowerUrl.includes(rule.match);
    if (!matchesHost && !matchesPath) continue;
    const classification: Classification = {
      sourceType: rule.type,
      tier: tierForType(rule.type, options.registry),
    };
    if (rule.technology) classification.technology = rule.technology;
    return classification;
  }

  if (options.registry.communityPatterns.some((pattern) => host.includes(pattern.toLowerCase()))) {
    return { sourceType: "community", tier: tierForType("community", options.registry) };
  }

  return { sourceType: "general-web", tier: tierForType("general-web", options.registry) };
}

export interface RankOptions extends ClassifyOptions {
  /** Technologies the task actually concerns; boosts on-topic sources. */
  technologies?: string[];
  /** Reference "now" for recency scoring (injectable for deterministic tests). */
  now?: number;
  /** Maximum age, in days, before recency contributes nothing. */
  recencyHalfLifeDays?: number;
}

const TIER_WEIGHT = 100;
const RELEVANCE_WEIGHT = 6;
const TECHNOLOGY_WEIGHT = 25;
const RECENCY_WEIGHT = 8;

/**
 * Score and order sources.
 *
 * score = tier (dominant) + lexical relevance + technology match + recency
 */
export function rankSources(
  sources: readonly ResearchSource[],
  query: string,
  options: RankOptions,
): RankedSource[] {
  const queryTerms = new Set(tokenize(query));
  const technologies = new Set((options.technologies ?? []).map((t) => t.toLowerCase()));
  const now = options.now ?? Date.now();
  const halfLife = options.recencyHalfLifeDays ?? 365;

  const ranked: RankedSource[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);

    const haystack = tokenize(`${source.title} ${source.snippet}`);
    let matched = 0;
    for (const term of haystack) {
      if (queryTerms.has(term)) matched += 1;
    }
    const relevance =
      queryTerms.size === 0 ? 0 : Math.min(2, (matched / Math.max(1, queryTerms.size)) * 4);

    const technologyMatch =
      source.technology !== undefined && technologies.has(source.technology.toLowerCase()) ? 1 : 0;

    const ageDays = Math.max(0, (now - Date.parse(source.retrievedAt)) / 86_400_000);
    const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / halfLife) : 0;

    const score =
      (9 - source.tier) * TIER_WEIGHT +
      relevance * RELEVANCE_WEIGHT +
      technologyMatch * TECHNOLOGY_WEIGHT +
      recency * RECENCY_WEIGHT;

    const parts = [
      `tier ${source.tier} (${source.sourceType})`,
      `relevance ${relevance.toFixed(2)}`,
    ];
    if (technologyMatch === 1) parts.push(`matches technology ${source.technology}`);
    if (recency < 0.2) parts.push("possibly stale");

    ranked.push({ ...source, score: Number(score.toFixed(2)), rationale: parts.join(", ") });
  }

  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked;
}

/**
 * Decide which tier is good enough to stop searching at.
 * If tier-2 documentation answered the question, community sources are only
 * used for troubleshooting.
 */
export function highestTrustTier(sources: readonly ResearchSource[]): number {
  if (sources.length === 0) return 8;
  return Math.min(...sources.map((source) => source.tier));
}

/** Prefer project-local and official material for the "primary evidence" slot. */
export function primarySources(sources: readonly RankedSource[], minTier = 3): RankedSource[] {
  return sources.filter((source) => source.tier <= minTier);
}

/** Group sources by tier for a readable report section. */
export function groupByTier(
  sources: readonly RankedSource[],
): Array<{ tier: number; type: SourceType; sources: RankedSource[] }> {
  const groups = new Map<number, { tier: number; type: SourceType; sources: RankedSource[] }>();
  for (const source of sources) {
    const existing = groups.get(source.tier);
    if (existing) {
      existing.sources.push(source);
    } else {
      groups.set(source.tier, { tier: source.tier, type: source.sourceType, sources: [source] });
    }
  }
  return [...groups.values()].sort((a, b) => a.tier - b.tier);
}

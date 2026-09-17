/**
 * Live web research.
 *
 * Search results are not evidence; reading the page is. This module searches,
 * classifies every result against the trust registry, reads only the highest
 * ranked pages, and returns sources that carry their own provenance — so a
 * finding can always be traced back to the page it came from.
 */

import type { SourcesRegistry } from "../config/registries.js";
import type { ToolContext, ToolRegistry } from "../tools/types.js";
import type { Logger } from "../util/logger.js";
import { truncate } from "../util/text.js";
import { classifyUrl, rankSources } from "./sources/ranking.js";
import type { RankedSource, ResearchSource } from "./types.js";

export interface WebResearchOptions {
  tools: ToolRegistry;
  toolContext: ToolContext;
  sourcesRegistry: SourcesRegistry;
  queries: string[];
  technologies: string[];
  /** Results requested per query. */
  resultsPerQuery: number;
  /** Pages actually fetched; the rest stay snippet-only. */
  maxPagesToRead: number;
  logger: Logger;
  /** Maximum pages fetched concurrently. */
  concurrency?: number;
  /** Retrieval timestamp; injectable so tests are deterministic. */
  now?: Date;
}

export interface WebResearchResult {
  sources: RankedSource[];
  /** Explicit statements about what could not be done, surfaced in the report. */
  limitations: string[];
  queriesRun: string[];
}

export async function gatherWebResearch(options: WebResearchOptions): Promise<WebResearchResult> {
  const limitations: string[] = [];
  const queriesRun: string[] = [];
  const collected: ResearchSource[] = [];
  const retrievedAt = (options.now ?? new Date()).toISOString();

  for (const query of options.queries) {
    try {
      const raw = (await options.tools.invoke(
        "web_search",
        { query, limit: options.resultsPerQuery },
        options.toolContext,
      )) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };

      queriesRun.push(query);
      for (const result of raw.results ?? []) {
        if (typeof result.url !== "string" || result.url.length === 0) continue;
        const classification = classifyUrl(result.url, { registry: options.sourcesRegistry });
        const source: ResearchSource = {
          id: result.url,
          title: result.title ?? result.url,
          url: result.url,
          sourceType: classification.sourceType,
          tier: classification.tier,
          snippet: truncate(result.snippet ?? "", 800),
          retrievedAt,
        };
        if (classification.technology) source.technology = classification.technology;
        collected.push(source);
      }
    } catch (error) {
      limitations.push(`Search failed for "${query}": ${(error as Error).message}`);
      options.logger.warn("Web search failed", { query, error: (error as Error).message });
    }
  }

  if (queriesRun.length === 0 && collected.length === 0 && limitations.length === 0) {
    limitations.push("No web search provider is configured; research used local knowledge only.");
  }

  const ranked = rankSources(collected, options.queries.join(" "), {
    registry: options.sourcesRegistry,
    technologies: options.technologies,
    now: (options.now ?? new Date()).getTime(),
  });

  const pagesToRead = selectPagesToRead(ranked, options.maxPagesToRead);
  const enriched = await readPages(options, pagesToRead);
  if (ranked.length > pagesToRead.length && pagesToRead.length > 0) {
    limitations.push(
      `Read ${pagesToRead.length} of ${ranked.length} results in full; the rest contributed snippets only.`,
    );
  }

  return { sources: enriched, limitations, queriesRun };
}

/** Read official material first, then official repositories, then the rest. */
export function selectPagesToRead(ranked: readonly RankedSource[], maxPages: number): RankedSource[] {
  const readable = ranked.filter((source) => source.url !== undefined);
  const ordered = [...readable].sort((a, b) => a.tier - b.tier || b.score - a.score);
  return ordered.slice(0, maxPages);
}

async function readPages(
  options: WebResearchOptions,
  pages: readonly RankedSource[],
): Promise<RankedSource[]> {
  const concurrency = options.concurrency ?? 3;
  const byUrl = new Map<string, RankedSource>();
  const queue = [...pages];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next || !next.url) break;
      try {
        const page = (await options.tools.invoke(
          "read_web_page",
          { url: next.url, maxChars: 12_000 },
          options.toolContext,
        )) as { title?: string; text?: string };

        byUrl.set(next.url, {
          ...next,
          title: page.title && page.title.length > 0 ? page.title : next.title,
          snippet: truncate(page.text ?? next.snippet, 3_000),
        });
      } catch (error) {
        options.logger.warn("Failed to read page", {
          url: next.url,
          error: (error as Error).message,
        });
        byUrl.set(next.url, next);
      }
    }
  });

  await Promise.all(workers);

  // Preserve the ranking order, with the richer snippets spliced back in.
  return pages.map((page) => (page.url ? (byUrl.get(page.url) ?? page) : page));
}
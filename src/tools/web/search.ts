/**
 * Web search.
 *
 * Canvil uses structured search APIs rather than scraping result pages: they are
 * stable, licensed, and return snippets we can rank. If no provider is
 * configured, search is *unavailable* rather than silently degraded — the
 * research layer reports that limitation instead of pretending it searched.
 */

import type { CanvilEnv, LimitSettings } from "../../config/types.js";
import { ExternalServiceError } from "../../util/errors.js";
import { fetchText, isSuccessStatus, parseJsonBody } from "../../util/http.js";

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** Provider-specific relevance score when supplied. */
  providerScore?: number;
  publishedAt?: string;
}

export interface WebSearchClient {
  readonly provider: string;
  search(query: string, limit: number): Promise<WebResult[]>;
}

export interface WebSearchContext {
  env: CanvilEnv;
  limits: LimitSettings;
  fetchImpl: typeof fetch;
}

/** The first configured provider wins; order encodes a quality preference. */
export function createWebSearchClient(context: WebSearchContext): WebSearchClient | null {
  if (context.env.tavilyApiKey) return new TavilySearchClient(context);
  if (context.env.braveApiKey) return new BraveSearchClient(context);
  if (context.env.searxngUrl) return new SearxngSearchClient(context);
  return null;
}

class TavilySearchClient implements WebSearchClient {
  readonly provider = "tavily";

  constructor(private readonly context: WebSearchContext) {}

  async search(query: string, limit: number): Promise<WebResult[]> {
    const result = await fetchText(this.context.fetchImpl, "https://api.tavily.com/search", {
      method: "POST",
      timeoutMs: this.context.limits.requestTimeoutMs,
      maxBytes: this.context.limits.maxFetchBytes,
      userAgent: this.context.limits.userAgent,
      body: JSON.stringify({
        api_key: this.context.env.tavilyApiKey,
        query,
        max_results: limit,
        search_depth: "advanced",
        include_answer: false,
      }),
    });

    const payload = parseJsonBody<TavilyResponse>(result, "Tavily");
    return (payload.results ?? [])
      .filter((entry) => typeof entry.url === "string")
      .map((entry) => {
        const mapped: WebResult = {
          title: entry.title ?? entry.url ?? "",
          url: entry.url ?? "",
          snippet: entry.content ?? "",
        };
        if (typeof entry.score === "number") mapped.providerScore = entry.score;
        if (entry.published_date) mapped.publishedAt = entry.published_date;
        return mapped;
      });
  }
}

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }>;
}

class BraveSearchClient implements WebSearchClient {
  readonly provider = "brave";

  constructor(private readonly context: WebSearchContext) {}

  async search(query: string, limit: number): Promise<WebResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(limit, 20)));

    const result = await fetchText(this.context.fetchImpl, url.toString(), {
      timeoutMs: this.context.limits.requestTimeoutMs,
      maxBytes: this.context.limits.maxFetchBytes,
      userAgent: this.context.limits.userAgent,
      headers: {
        "x-subscription-token": this.context.env.braveApiKey ?? "",
        accept: "application/json",
      },
    });

    if (!isSuccessStatus(result.status)) {
      throw new ExternalServiceError(
        `Brave Search returned HTTP ${result.status}: ${result.body.slice(0, 200)}`,
        "brave",
      );
    }

    const payload = parseJsonBody<BraveResponse>(result, "Brave Search");
    return (payload.web?.results ?? [])
      .filter((entry) => typeof entry.url === "string")
      .map((entry) => ({
        title: entry.title ?? entry.url ?? "",
        url: entry.url ?? "",
        // Brave nests the readable snippet under `extra_snippets`/`description`.
        snippet: entry.description ?? entry.extra_snippets?.join(" ") ?? "",
        ...(entry.age ? { publishedAt: entry.age } : {}),
      }));
  }
}

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      extra_snippets?: string[];
    }>;
  };
}

class SearxngSearchClient implements WebSearchClient {
  readonly provider = "searxng";

  constructor(private readonly context: WebSearchContext) {}

  async search(query: string, limit: number): Promise<WebResult[]> {
    const base = (this.context.env.searxngUrl ?? "").replace(/\/$/, "");
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const result = await fetchText(this.context.fetchImpl, url.toString(), {
      timeoutMs: this.context.limits.requestTimeoutMs,
      maxBytes: this.context.limits.maxFetchBytes,
      userAgent: this.context.limits.userAgent,
    });

    const payload = parseJsonBody<SearxngResponse>(result, "SearxNG");
    return (payload.results ?? [])
      .filter((entry) => typeof entry.url === "string")
      .slice(0, limit)
      .map((entry, index) => ({
        title: entry.title ?? entry.url ?? "",
        url: entry.url ?? "",
        snippet: entry.content ?? "",
        // SearxNG does not score; preserve its ordering as a decaying score.
        providerScore: Number((1 - index / Math.max(1, limit)).toFixed(4)),
        ...(entry.publishedDate ? { publishedAt: entry.publishedDate } : {}),
      }));
  }
}

interface SearxngResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string;
  }>;
}
/**
 * Web tools exposed to the agent: `web_search` and `read_web_page`.
 *
 * Both return plain, serializable records; the research layer classifies and
 * ranks the URLs they return, so the tools themselves stay provider-agnostic.
 */

import { z } from "zod";
import { MissingCredentialError } from "../../util/errors.js";
import { defineTool } from "../types.js";
import { createWebSearchClient } from "./search.js";
import { readWebPage } from "./read-page.js";

export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "Search the public web for a query and return ranked results (title, URL, snippet). Requires a configured search provider (TAVILY_API_KEY, BRAVE_API_KEY or CANVIL_SEARXNG_URL).",
  effect: "network",
  schema: z.object({
    query: z.string().min(2).describe("The search query, as specific as possible"),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(input, context) {
    const client = createWebSearchClient({
      env: context.env,
      limits: context.config.limits,
      fetchImpl: context.fetchImpl,
    });
    if (!client) {
      throw new MissingCredentialError(
        "web_search is unavailable: set TAVILY_API_KEY, BRAVE_API_KEY or CANVIL_SEARXNG_URL. Canvil will fall back to local knowledge only.",
        "TAVILY_API_KEY",
      );
    }
    const limit = input.limit ?? context.config.limits.maxWebResults;
    const results = await client.search(input.query, limit);
    return { provider: client.provider, query: input.query, results };
  },
});

export const readWebPageTool = defineTool({
  name: "read_web_page",
  description:
    "Fetch a URL and return its readable text, headings and code blocks. Use after web_search to read the most authoritative result.",
  effect: "network",
  schema: z.object({
    url: z.string().url(),
    maxChars: z.number().int().min(500).max(60_000).optional(),
    /** Only keep the part of the page that mentions this text. */
    focus: z.string().min(2).optional().describe("Keep paragraphs mentioning this term"),
  }),
  async execute(input, context) {
    const page = await readWebPage(context.fetchImpl, input.url, {
      maxChars: input.maxChars ?? 12_000,
      timeoutMs: context.config.limits.requestTimeoutMs,
      maxBytes: context.config.limits.maxFetchBytes,
      userAgent: context.config.limits.userAgent,
    });

    if (!input.focus) return page;

    const focusTerms = input.focus.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
    const paragraphs = page.text.split(/\n{2,}/);
    const relevant = paragraphs.filter((paragraph) => {
      const lower = paragraph.toLowerCase();
      return focusTerms.some((term) => lower.includes(term));
    });
    const focused = relevant.length > 0 ? relevant.join("\n\n") : page.text;

    return {
      ...page,
      text: focused,
      focusApplied: relevant.length > 0,
      matchedParagraphs: relevant.length,
    };
  },
});
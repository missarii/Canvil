/**
 * Web page reading and HTML -> text extraction.
 *
 * Reading a page turns a search hit into usable evidence, so the extraction
 * keeps code blocks and headings intact: those are exactly the parts an agent
 * needs when implementing against documentation.
 */

import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
// `domhandler` is a direct dependency of cheerio and the only place the DOM
// node union is exported from; it is declared in package.json because we import
// its types. Type-only, so nothing lands in the bundle.
import type { AnyNode } from "domhandler";
import { ExternalServiceError } from "../../util/errors.js";
import { fetchText, isSuccessStatus } from "../../util/http.js";
import { normalizeWhitespace, truncate } from "../../util/text.js";

/** A cheerio selection; the element type is fixed so selections interoperate. */
type CheerioSelection = Cheerio<AnyNode>;

/** Elements that never contribute documentation content. */
const STRIPPED_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "form",
  "nav",
  "footer",
  "header",
  "aside",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "[aria-hidden=true]",
  ".sidebar",
  ".side-bar",
  ".navigation",
  ".nav",
  ".menu",
  ".footer",
  ".header",
  ".cookie",
  ".cookie-banner",
  ".breadcrumb",
  ".toc",
  ".table-of-contents",
  ".advertisement",
  ".ads",
];

/** Ordered by how likely each container holds the real content. */
const CONTENT_SELECTORS = [
  "main",
  "article",
  "[role=main]",
  "#content",
  ".content",
  ".markdown-body",
  ".prose",
  ".documentation",
  ".docs-content",
  "body",
];

export interface ExtractedPage {
  title: string;
  text: string;
  codeBlocks: string[];
  truncated: boolean;
}

const BLOCK_TAGS = ["p", "div", "section", "article", "blockquote", "table"];

export function extractReadableContent(html: string, maxChars: number): ExtractedPage {
  const $ = cheerio.load(html);
  for (const selector of STRIPPED_SELECTORS) {
    $(selector).remove();
  }

  const title = normalizeWhitespace($("title").first().text() || $("h1").first().text() || "");

  let root: CheerioSelection | null = null;
  for (const selector of CONTENT_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length > 0 && candidate.text().trim().length > 200) {
      root = candidate as unknown as CheerioSelection;
      break;
    }
  }
  if (!root) root = $("body") as unknown as CheerioSelection;

  const lines: string[] = [];
  const codeBlocks: string[] = [];

  const walk = (element: CheerioSelection): void => {
    for (const node of element.contents().toArray()) {
      if (node.type === "text") {
        const text = (node.data ?? "").replace(/\s+/g, " ").trim();
        if (text.length > 0) lines.push(text);
        continue;
      }
      if (!("tagName" in node)) continue;

      const node$ = $(node) as unknown as CheerioSelection;
      const tagName = (node.tagName ?? "").toLowerCase();

      if (tagName === "pre") {
        // Code keeps its whitespace verbatim; collapsing it destroys it.
        const code = node$.text().replace(/^\n+|\n+$/g, "");
        if (code.length > 0) {
          codeBlocks.push(code);
          lines.push("", `\`\`\`${detectLanguage(node$)}\n${code}\n\`\`\``, "");
        }
        continue;
      }
      if (/^h[1-6]$/.test(tagName)) {
        const level = Number(tagName.slice(1));
        lines.push("", `${"#".repeat(level)} ${node$.text().replace(/\s+/g, " ").trim()}`, "");
        continue;
      }
      if (tagName === "li") {
        const nested = node$.children("ul,ol");
        const ownText = node$
          .clone()
          .children("ul,ol")
          .remove()
          .end()
          .text()
          .replace(/\s+/g, " ")
          .trim();
        if (ownText.length > 0) lines.push(`- ${ownText}`);
        if (nested.length > 0) walk(nested as unknown as CheerioSelection);
        continue;
      }
      if (tagName === "tr") {
        const cells = node$
          .find("th,td")
          .toArray()
          .map((cell) => $(cell).text().replace(/\s+/g, " ").trim());
        if (cells.some((cell) => cell.length > 0)) lines.push(`| ${cells.join(" | ")} |`);
        continue;
      }
      if (tagName === "a") {
        const href = node$.attr("href") ?? "";
        const label = node$.text().replace(/\s+/g, " ").trim();
        if (label.length === 0) continue;
        lines.push(href.length === 0 || href.startsWith("#") ? label : `${label} (${href})`);
        continue;
      }
      if (tagName === "code") {
        const inline = node$.text().replace(/\s+/g, " ").trim();
        if (inline.length > 0) lines.push(`\`${inline}\``);
        continue;
      }

      walk(node$);
      if (BLOCK_TAGS.includes(tagName)) lines.push("");
    }
  };

  walk(root);

  const rawText = lines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const wasTruncated = rawText.length > maxChars;
  return {
    title,
    text: truncate(normalizeWhitespace(rawText), maxChars),
    // Only report code blocks the model actually saw after truncation.
    codeBlocks: wasTruncated
      ? codeBlocks.filter((block) => rawText.indexOf(block) < maxChars)
      : codeBlocks,
    truncated: wasTruncated,
  };
}

function detectLanguage(node: CheerioSelection): string {
  const className = node.find("code").first().attr("class") ?? node.attr("class") ?? "";
  const match = /(?:language|lang)-([a-z0-9+#]+)/i.exec(className);
  return match?.[1] ?? "";
}

export interface ReadPageOptions {
  maxChars: number;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

export interface ReadPageResult extends ExtractedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  /** Present when the body was cut at maxBytes before extraction. */
  bodyTruncated: boolean;
}

/** Fetch and extract a single page. Throws ExternalServiceError on failure. */
export async function readWebPage(
  fetchImpl: typeof fetch,
  url: string,
  options: ReadPageOptions,
): Promise<ReadPageResult> {
  const result = await fetchText(fetchImpl, url, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    userAgent: options.userAgent,
    accept: ["text/html", "text/plain", "application/xhtml+xml", "application/json"],
  });

  if (!isSuccessStatus(result.status)) {
    throw new ExternalServiceError(`HTTP ${result.status} while reading ${url}`, "web-page");
  }

  const isJson = result.contentType.includes("json");
  const extracted: ExtractedPage = isJson
    ? {
        title: result.finalUrl,
        text: truncate(result.body, options.maxChars),
        codeBlocks: [],
        truncated: result.body.length > options.maxChars,
      }
    : extractReadableContent(result.body, options.maxChars);

  return {
    ...extracted,
    url,
    finalUrl: result.finalUrl,
    status: result.status,
    contentType: result.contentType,
    bytes: result.bytes,
    bodyTruncated: result.truncated,
  };
}
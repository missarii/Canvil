/**
 * Text utilities shared by the RAG store, web reader and project scanner.
 * Pure functions only: no I/O, no globals.
 */

/** Rough token estimate (~4 chars/token) for budget decisions, not billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Hard-truncate with an explicit marker so the model never sees silent cuts. */
export function truncate(text: string, maxChars: number, marker = "\n…[truncated]"): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}

/** Keep the head *and* the tail: logs and test output matter at both ends. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n…[${text.length - maxChars} chars omitted]…\n${text.slice(-half)}`;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "doing",
  "have", "has", "had", "having", "to", "of", "in", "on", "at", "by", "for", "with", "about",
  "against", "between", "into", "through", "during", "before", "after", "above", "below",
  "from", "up", "down", "out", "off", "over", "under", "again", "further", "once", "here",
  "there", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "too", "very",
  "can", "will", "just", "should", "now", "me", "my", "we", "our", "you", "your", "it",
  "its", "they", "them", "their", "what", "which", "who", "whom", "as", "also", "use", "using",
  "used", "get", "got", "make", "made", "want", "need", "please", "add", "new",
]);

/**
 * Tokenize for lexical retrieval: lowercase, split camelCase/snake_case,
 * drop punctuation and stop words. `readFile` becomes `read` + `file`.
 */
export function tokenize(text: string): string[] {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

  const raw = expanded.match(/[a-z0-9][a-z0-9.+#]*/g) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (token.length < 2 && !/^[0-9]$/.test(token)) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/** Escape a string for safe inclusion in a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type MarkdownChunk = { heading: string; content: string };

/**
 * Split markdown into heading-delimited chunks. Content before the first
 * heading becomes a chunk titled by `fallbackTitle`. Oversized sections are
 * split on paragraph boundaries so a chunk never blows the context budget.
 */
export function chunkMarkdown(
  markdown: string,
  options: { fallbackTitle?: string; maxChars?: number } = {},
): MarkdownChunk[] {
  const maxChars = options.maxChars ?? 1800;
  const lines = normalizeWhitespace(markdown).split("\n");
  const chunks: MarkdownChunk[] = [];
  let heading = options.fallbackTitle ?? "Overview";
  let buffer: string[] = [];

  const flush = (): void => {
    const content = buffer.join("\n").trim();
    buffer = [];
    if (content.length === 0) return;
    for (const piece of splitByParagraph(content, maxChars)) {
      chunks.push({ heading, content: piece });
    }
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match && match[2]) {
      flush();
      heading = match[2].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

function splitByParagraph(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current.length > 0 && current.length + paragraph.length + 2 > maxChars) {
      parts.push(current.trim());
      current = "";
    }
    if (paragraph.length > maxChars) {
      for (let i = 0; i < paragraph.length; i += maxChars) {
        parts.push(paragraph.slice(i, i + maxChars).trim());
      }
      continue;
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * Collapse HTML into readable text without pulling in a parser. Used as a
 * fallback when the cheerio extraction yields nothing.
 */
export function htmlToText(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|pre)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'"),
  );
}

/** Extract fenced code blocks (```lang ... ```) from a document. */
export function extractCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const body = match[1]?.trim();
    if (body && body.length > 0) blocks.push(body);
  }
  return blocks;
}

/** Turn any text into a single-line, fixed-width preview for logs/reports. */
export function oneLine(text: string, maxChars = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** Deterministic key ordering, so serialized artifacts diff cleanly. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

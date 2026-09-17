/**
 * Local knowledge base (RAG).
 *
 * Loads the markdown knowledge base, chunks it by heading and indexes it for
 * lexical retrieval. This is tier-1.5 knowledge: curated by you, stable over
 * time, and available with no network and no API key — which is exactly the
 * material that should *not* be fetched from the web on every run.
 */

import fs from "node:fs";
import path from "node:path";
import type { ResearchSource } from "../types.js";
import { knowledgeBasePath } from "../../config/loader.js";
import { toPosix } from "../../util/paths.js";
import { truncate } from "../../util/text.js";
import { LexicalIndex, documentsFromMarkdown, type RagHit, type RagDocument } from "./store.js";

export interface KnowledgeBaseOptions {
  /** Root of the markdown knowledge base. Defaults to `<canvil-home>/knowledge-base`. */
  directory?: string;
  /** Chunk size in characters. */
  maxChars?: number;
}

export interface KnowledgeBase {
  readonly directory: string;
  readonly index: LexicalIndex;
  /** Files that were indexed, relative to the knowledge base root. */
  readonly sources: string[];
  search(query: string, limit?: number): RagHit[];
  /** Convert hits into ranked-source-shaped records for the research report. */
  searchAsSources(query: string, limit?: number): ResearchSource[];
}

const KNOWLEDGE_TAGS = ["knowledge-base"];

/** Build the index by walking the knowledge base for markdown files. */
export function buildKnowledgeBase(options: KnowledgeBaseOptions = {}): KnowledgeBase {
  const directory = options.directory ?? knowledgeBasePath();
  const index = new LexicalIndex();
  const sources: string[] = [];

  const files = collectMarkdownFiles(directory);
  for (const file of files) {
    let markdown: string;
    try {
      markdown = fs.readFileSync(file.absolutePath, "utf8");
    } catch {
      continue;
    }
    const documents = documentsFromMarkdown({
      source: file.relativePath,
      markdown,
      idPrefix: `kb:${file.relativePath}`,
      tags: [...KNOWLEDGE_TAGS, ...tagsFromPath(file.relativePath)],
      fallbackTitle: path.basename(file.relativePath, ".md"),
      ...(options.maxChars ? { maxChars: options.maxChars } : {}),
    });
    index.addAll(documents);
    sources.push(file.relativePath);
  }

  return {
    directory,
    index,
    sources,
    search(query: string, limit = 5): RagHit[] {
      return index.search(query, { limit, tags: KNOWLEDGE_TAGS });
    },
    searchAsSources(query: string, limit = 5): ResearchSource[] {
      const retrievedAt = new Date().toISOString();
      return index.search(query, { limit, tags: KNOWLEDGE_TAGS }).map((hit) => toSource(hit, retrievedAt));
    },
  };
}

function toSource(hit: RagHit, retrievedAt: string): ResearchSource {
  const document: RagDocument = hit.document;
  return {
    id: `local:${document.id}`,
    title: `${document.heading} (${document.source})`,
    sourceType: "official-docs",
    // Curated internal knowledge sits between the user's project (1) and
    // third-party documentation (2); it is deliberately ranked as official.
    tier: 2,
    snippet: truncate(document.content, 600),
    retrievedAt,
    local: true,
  };
}

function tagsFromPath(relativePath: string): string[] {
  const segments = toPosix(relativePath).split("/");
  segments.pop();
  return segments.filter((segment) => segment.length > 0 && segment !== ".");
}

interface MarkdownFile {
  absolutePath: string;
  relativePath: string;
}

function collectMarkdownFiles(directory: string, current = directory): MarkdownFile[] {
  if (!fs.existsSync(current)) return [];
  const results: MarkdownFile[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(directory, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(md|mdx|markdown)$/i.test(entry.name)) continue;
    results.push({ absolutePath, relativePath: toPosix(path.relative(directory, absolutePath)) });
  }
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
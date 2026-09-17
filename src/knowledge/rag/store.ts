/**
 * Lexical (BM25) retrieval over chunked documents.
 *
 * Why not embeddings by default? Canvil has to work offline, in CI, and without
 * a second API bill — and a local code-aware index that never lies about its
 * provenance beats a remote embedding index that silently goes stale. The
 * `Retriever` interface below is the seam where a vector store plugs in later.
 */

import { chunkMarkdown, normalizeWhitespace, tokenize } from "../../util/text.js";

export interface RagDocument {
  id: string;
  /** Source file or URL this chunk came from. */
  source: string;
  /** Nearest heading, or a fallback title. */
  heading: string;
  content: string;
  /** Arbitrary labels used for filtering: "knowledge-base", "docs", "code". */
  tags: string[];
}

export interface RagHit {
  document: RagDocument;
  score: number;
  matchedTerms: string[];
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to documents carrying one of these tags. */
  tags?: string[];
  /** Drop hits below this BM25 score. */
  minScore?: number;
}

export interface Retriever {
  search(query: string, options?: SearchOptions): RagHit[];
  readonly size: number;
}

const K1 = 1.5;
const B = 0.75;

interface IndexedDocument {
  document: RagDocument;
  termFrequencies: Map<string, number>;
  length: number;
}

/**
 * Inverted index with BM25 scoring.
 *
 * Insertion is O(n) and search is O(terms), which is more than enough for a
 * knowledge base measured in thousands of chunks.
 */
export class LexicalIndex implements Retriever {
  private readonly documents: IndexedDocument[] = [];
  private readonly postings = new Map<string, Set<number>>();
  private readonly documentFrequency = new Map<string, number>();
  private totalLength = 0;

  get size(): number {
    return this.documents.length;
  }

  /** All indexed documents; used by the report generator and tests. */
  get all(): readonly RagDocument[] {
    return this.documents.map((entry) => entry.document);
  }

  add(document: RagDocument): void {
    const index = this.documents.length;
    const tokens = tokenize(`${document.heading} ${document.content}`);
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }

    const entry: IndexedDocument = { document, termFrequencies, length: tokens.length };
    this.documents.push(entry);
    this.totalLength += tokens.length;

    for (const term of termFrequencies.keys()) {
      const posting = this.postings.get(term);
      if (posting) {
        posting.add(index);
      } else {
        this.postings.set(term, new Set([index]));
      }
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
    }
  }

  addAll(documents: readonly RagDocument[]): void {
    for (const document of documents) this.add(document);
  }

  search(query: string, options: SearchOptions = {}): RagHit[] {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || this.documents.length === 0) return [];

    const averageLength = this.totalLength / this.documents.length || 1;
    const scores = new Map<number, number>();
    const matchedTermsByIndex = new Map<number, Set<string>>();

    for (const term of queryTerms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = this.documentFrequency.get(term) ?? 1;
      const idf = Math.log(1 + (this.documents.length - df + 0.5) / (df + 0.5));

      for (const index of posting) {
        const entry = this.documents[index];
        if (!entry) continue;
        if (options.tags && options.tags.length > 0) {
          const hasTag = options.tags.some((tag) => entry.document.tags.includes(tag));
          if (!hasTag) continue;
        }
        const tf = entry.termFrequencies.get(term) ?? 0;
        const denominator = tf + K1 * (1 - B + (B * entry.length) / averageLength);
        const contribution = idf * ((tf * (K1 + 1)) / (denominator || 1));
        scores.set(index, (scores.get(index) ?? 0) + contribution);

        const matched = matchedTermsByIndex.get(index);
        if (matched) {
          matched.add(term);
        } else {
          matchedTermsByIndex.set(index, new Set([term]));
        }
      }
    }

    // Reward documents covering more distinct query terms (coverage bonus).
    for (const [index, matched] of matchedTermsByIndex) {
      const coverage = matched.size / queryTerms.length;
      scores.set(index, (scores.get(index) ?? 0) * (1 + coverage));
    }

    return [...scores.entries()]
      .map(([index, score]) => ({
        document: this.documents[index]!.document,
        score: Number(score.toFixed(4)),
        matchedTerms: [...(matchedTermsByIndex.get(index) ?? [])].sort(),
      }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
      .slice(0, limit);
  }
}

/** Turn a markdown file into chunks ready for indexing. */
export function documentsFromMarkdown(options: {
  source: string;
  markdown: string;
  idPrefix: string;
  tags: string[];
  fallbackTitle?: string;
  maxChars?: number;
}): RagDocument[] {
  const chunks = chunkMarkdown(normalizeWhitespace(options.markdown), {
    fallbackTitle: options.fallbackTitle ?? options.source,
    maxChars: options.maxChars ?? 1800,
  });
  return chunks.map((chunk, index) => ({
    id: `${options.idPrefix}#${index}`,
    source: options.source,
    heading: chunk.heading,
    content: chunk.content,
    tags: [...options.tags],
  }));
}
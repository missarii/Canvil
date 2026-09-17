/**
 * Context selection.
 *
 * The alternative to reading the whole repository is not "read less" — it is
 * "read the right files". This scores candidate files against the task using
 * path signals and content signals, and returns an auditable reason for every
 * file it selects, so a bad context pack can be debugged instead of guessed at.
 */

import path from "node:path";
import { tokenize } from "../util/text.js";
import type { ProjectProfile } from "./types.js";
import { readTextFile, walkRepo } from "../tools/filesystem/walk.js";

export interface ContextFile {
  path: string;
  score: number;
  /** Why this file was selected. */
  reasons: string[];
  sizeBytes: number;
}

export interface SelectContextOptions {
  root: string;
  task: string;
  profile?: ProjectProfile;
  maxFiles?: number;
  /** Files already known to be relevant (e.g. from a failing test). */
  seedPaths?: string[];
}

const CANDIDATE_LIMIT = 400;
const MAX_CONTENT_BYTES_FOR_SCORING = 120_000;

/** Extensions worth reading when building a context pack. */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
  ".sql",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
];

export function selectContextFiles(options: SelectContextOptions): ContextFile[] {
  const maxFiles = options.maxFiles ?? 24;
  const taskTerms = new Set(tokenize(options.task));
  const seedPaths = new Set(options.seedPaths ?? []);
  const architectureHints = options.profile?.architectureHints ?? [];
  const entrypoints = new Set(options.profile?.entrypoints ?? []);
  const configFiles = new Set(options.profile?.configFiles ?? []);

  const candidates = walkRepo(options.root, {
    maxFiles: 20_000,
    extensions: SOURCE_EXTENSIONS,
  }).slice(0, CANDIDATE_LIMIT);

  const scored: ContextFile[] = [];

  for (const candidate of candidates) {
    const reasons: string[] = [];
    let score = 0;

    const lowerPath = candidate.relativePath.toLowerCase();
    const pathTerms = tokenize(candidate.relativePath);
    const pathMatches = pathTerms.filter((term) => taskTerms.has(term));
    if (pathMatches.length > 0) {
      score += Math.min(6, pathMatches.length * 2);
      reasons.push(`path matches: ${[...new Set(pathMatches)].slice(0, 4).join(", ")}`);
    }

    if (seedPaths.has(candidate.relativePath)) {
      score += 10;
      reasons.push("referenced by the task or a failing test");
    }
    if (entrypoints.has(candidate.relativePath)) {
      score += 3;
      reasons.push("detected entrypoint");
    }
    if (configFiles.has(candidate.relativePath)) {
      score += 2;
      reasons.push("configuration file");
    }
    if (architectureHints.some((hint) => lowerPath.includes(hint.replace(/-/g, "/")))) {
      score += 1;
    }

    // Content relevance: cheap distinct-term counting, capped so a long file
    // cannot win on volume alone.
    if (candidate.sizeBytes <= MAX_CONTENT_BYTES_FOR_SCORING) {
      let content: string;
      try {
        content = readTextFile(options.root, candidate.relativePath, {
          maxBytes: MAX_CONTENT_BYTES_FOR_SCORING,
        }).content;
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const term of tokenize(content)) {
        if (taskTerms.has(term) && !seen.has(term)) {
          seen.add(term);
          if (seen.size >= 8) break;
        }
      }
      if (seen.size > 0) {
        score += Math.min(8, seen.size);
        reasons.push(`${seen.size} task term(s) found in the file`);
      }
    }

    if (score <= 0) continue;
    scored.push({ path: candidate.relativePath, score, reasons, sizeBytes: candidate.sizeBytes });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, maxFiles);
}

export interface ReadContextOptions {
  root: string;
  /** Character budget shared across all files. */
  totalBudget?: number;
  /** Per-file ceiling. */
  perFileBudget?: number;
}

export interface ContextPackEntry {
  path: string;
  content: string;
  truncated: boolean;
  score: number;
  reasons: string[];
}

export interface ContextPack {
  files: ContextPackEntry[];
  /** Files dropped because the budget ran out, in priority order. */
  omitted: string[];
  charactersUsed: number;
}

/**
 * Read the selected files into a budgeted context pack.
 *
 * Budget is spent highest-score-first, and a file that does not fit is reported
 * as omitted rather than silently half-included.
 */
export function readContextPack(
  files: readonly ContextFile[],
  options: ReadContextOptions,
): ContextPack {
  const totalBudget = options.totalBudget ?? 120_000;
  const perFileBudget = options.perFileBudget ?? 30_000;
  const entries: ContextPackEntry[] = [];
  const omitted: string[] = [];
  let charactersUsed = 0;

  for (const file of files) {
    const remaining = totalBudget - charactersUsed;
    if (remaining <= 1_000) {
      omitted.push(file.path);
      continue;
    }

    let content: string;
    let truncated = false;
    try {
      const read = readTextFile(options.root, file.path, {
        maxBytes: Math.min(perFileBudget, remaining),
      });
      if (read.binary) {
        omitted.push(file.path);
        continue;
      }
      content = read.content;
      truncated = read.truncated;
    } catch {
      omitted.push(file.path);
      continue;
    }

    charactersUsed += content.length;
    entries.push({
      path: file.path,
      content,
      truncated,
      score: file.score,
      reasons: file.reasons,
    });
  }

  return { files: entries, omitted, charactersUsed };
}

/** Render a context pack as a prompt section with explicit provenance. */
export function renderContextPack(pack: ContextPack): string {
  const sections = pack.files.map(
    (file) =>
      `### FILE: ${file.path}${file.truncated ? " (truncated)" : ""}\n` +
      `<!-- selected because: ${file.reasons.join("; ") || "relevance score"} -->\n` +
      "```\n" +
      file.content +
      "\n```",
  );
  if (pack.omitted.length > 0) {
    sections.push(
      `### OMITTED FOR BUDGET\n${pack.omitted.map((file) => `- ${file}`).join("\n")}\n` +
        "Use read_file if you need them.",
    );
  }
  return sections.join("\n\n");
}

/** True when a path looks like a test file (used to seed failing-test context). */
export function isTestPath(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  return (
    /\.(test|spec)\.[a-z]+$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(go|py)$/.test(base) ||
    relativePath.includes("__tests__/") ||
    /(^|\/)tests?\//.test(relativePath)
  );
}
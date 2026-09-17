/**
 * Repository walking.
 *
 * One shared implementation of "which files are actually part of this project",
 * so read, search, list and the project scanner never disagree.
 */

import fs from "node:fs";
import path from "node:path";
import { looksBinary, matchesAnyGlob, relativeToRoot, toPosix } from "../../util/paths.js";

export const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "vendor",
  ".idea",
  ".vscode-test",
  "tmp",
  "temp",
];

export const DEFAULT_IGNORED_GLOBS = [
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "Cargo.lock",
  "**/*.snap",
  "**/__snapshots__/**",
];

/** Extensions Canvil treats as text even without reading them. */
export const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".jsonc", ".json5", ".md", ".mdx", ".txt", ".rst",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".php", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".mm", ".scala", ".clj", ".ex", ".exs",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".sql", ".graphql", ".gql", ".proto", ".tf", ".tfvars", ".hcl",
  ".properties", ".gradle",
  ".csv", ".tsv", ".xml", ".svg",
]);

export interface WalkOptions {
  /** Extra directory names to skip, on top of the defaults. */
  ignoreDirectories?: string[];
  /** Extra globs (repo-relative, POSIX) to skip. */
  ignoreGlobs?: string[];
  /** Stop after this many files; guards against a runaway monorepo. */
  maxFiles?: number;
  /** Follow symlinks (off by default: a link can escape the repo). */
  followSymlinks?: boolean;
  /** Filter by extension (with or without the leading dot). */
  extensions?: string[];
}

export interface WalkedFile {
  /** Absolute path. */
  absolutePath: string;
  /** Repo-relative POSIX path; the identifier used everywhere else. */
  relativePath: string;
  sizeBytes: number;
}

/**
 * Depth-first walk of a repository, honouring ignore rules and never leaving
 * the root. Unreadable entries are skipped rather than thrown: a broken
 * symlink in someone's repo must not abort a run.
 */
export function walkRepo(root: string, options: WalkOptions = {}): WalkedFile[] {
  const ignoredDirectories = new Set([
    ...DEFAULT_IGNORED_DIRECTORIES,
    ...(options.ignoreDirectories ?? []),
  ]);
  const ignoreGlobs = [...DEFAULT_IGNORED_GLOBS, ...(options.ignoreGlobs ?? [])];
  const maxFiles = options.maxFiles ?? 20_000;
  const extensions = options.extensions?.map((ext) =>
    ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );

  const results: WalkedFile[] = [];
  const stack: string[] = [path.resolve(root)];

  while (stack.length > 0) {
    if (results.length >= maxFiles) break;
    const current = stack.pop();
    if (current === undefined) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(path.resolve(root), absolutePath));

      if (entry.isSymbolicLink() && !options.followSymlinks) continue;

      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        if (matchesAnyGlob(`${relativePath}/`, ignoreGlobs)) continue;
        if (matchesAnyGlob(relativePath, ignoreGlobs)) continue;
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (matchesAnyGlob(relativePath, ignoreGlobs)) continue;
      if (extensions && !extensions.includes(path.extname(entry.name).toLowerCase())) continue;

      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(absolutePath).size;
      } catch {
        continue;
      }

      results.push({ absolutePath, relativePath, sizeBytes });
      if (results.length >= maxFiles) break;
    }
  }

  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export interface ReadTextFileOptions {
  maxBytes?: number;
  /** Reject binary files instead of returning mojibake. */
  rejectBinary?: boolean;
}

export interface TextFileContents {
  relativePath: string;
  content: string;
  sizeBytes: number;
  /** True when the file was larger than `maxBytes` and got cut. */
  truncated: boolean;
  binary: boolean;
}

/** Read a file as UTF-8 text with size and binary guards. */
export function readTextFile(
  root: string,
  relativePath: string,
  options: ReadTextFileOptions = {},
): TextFileContents {
  const maxBytes = options.maxBytes ?? 400_000;
  const absolutePath = path.resolve(root, relativePath);
  const stats = fs.statSync(absolutePath);
  const buffer = fs.readFileSync(absolutePath);
  const binary = looksBinary(buffer);
  if (binary && options.rejectBinary !== false) {
    return {
      relativePath: toPosix(relativePath),
      content: "",
      sizeBytes: stats.size,
      truncated: false,
      binary: true,
    };
  }
  const truncated = buffer.length > maxBytes;
  const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return {
    relativePath: toPosix(relativePath),
    content: slice.toString("utf8"),
    sizeBytes: stats.size,
    truncated,
    binary,
  };
}

/** Cheap text/binary guess from the extension alone (no I/O). */
export function isProbablyTextFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (extension.length === 0) return true;
  return TEXT_EXTENSIONS.has(extension);
}

export { relativeToRoot };
/**
 * Filesystem tools: read_file, write_file, edit_file, list_files, search_code.
 *
 * All five share one rule: the path is resolved through the workspace jail and
 * then through the filesystem policy. Nothing writes directly.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolContext } from "../types.js";
import { CommandFailedError, PathSecurityError } from "../../util/errors.js";
import { matchesAnyGlob, relativeToRoot, resolveInside, toPosix } from "../../util/paths.js";
import { truncate } from "../../util/text.js";
import { isProbablyTextFile, readTextFile, walkRepo } from "./walk.js";

/** Reject a write that the policy forbids, before touching the disk. */
export function assertWritable(context: ToolContext, relativePath: string): string {
  const absolutePath = resolveInside(context.repoRoot, relativePath);
  const relative = toPosix(relativeToRoot(context.repoRoot, absolutePath));
  const policy = context.config.filesystem;

  if (matchesAnyGlob(relative, policy.protectedPaths)) {
    throw new PathSecurityError(
      `Refusing to modify protected path "${relative}" (matched filesystem.protectedPaths)`,
      relative,
    );
  }
  if (!matchesAnyGlob(relative, policy.writableGlobs)) {
    throw new PathSecurityError(
      `Refusing to modify "${relative}": outside filesystem.writableGlobs`,
      relative,
    );
  }
  return absolutePath;
}

/* -------------------------------------------------------------------------- */
/* read_file                                                                  */
/* -------------------------------------------------------------------------- */

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file from the repository. Supports a line range so large files can be paged.",
  effect: "read",
  schema: z.object({
    path: z.string().min(1).describe("Repository-relative path, e.g. src/auth/auth.service.ts"),
    startLine: z.number().int().min(1).optional().describe("First line to return (1-based)"),
    endLine: z.number().int().min(1).optional().describe("Last line to return (inclusive)"),
  }),
  async execute(input, context) {
    const absolutePath = resolveInside(context.repoRoot, input.path);
    if (!fs.existsSync(absolutePath)) {
      throw new CommandFailedError(`File does not exist: ${input.path}`, {
        exitCode: 1,
        stdout: "",
        stderr: "ENOENT",
        timedOut: false,
      });
    }
    if (fs.statSync(absolutePath).isDirectory()) {
      throw new CommandFailedError(`Path is a directory, use list_files: ${input.path}`, {
        exitCode: 1,
        stdout: "",
        stderr: "EISDIR",
        timedOut: false,
      });
    }

    const file = readTextFile(context.repoRoot, input.path, {
      maxBytes: context.config.filesystem.maxFileSizeBytes,
    });
    if (file.binary) {
      return {
        path: file.relativePath,
        binary: true,
        content: "",
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        truncated: false,
      };
    }

    const allLines = file.content.split("\n");
    const start = input.startLine === undefined ? 1 : input.startLine;
    const end =
      input.endLine === undefined ? allLines.length : Math.min(input.endLine, allLines.length);
    const content = allLines.slice(start - 1, end).join("\n");

    return {
      path: file.relativePath,
      binary: false,
      content,
      startLine: start,
      endLine: end,
      totalLines: allLines.length,
      truncated: file.truncated,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* write_file                                                                 */
/* -------------------------------------------------------------------------- */

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file, creating parent directories. Protected paths (.env, keys, .git internals) are refused.",
  effect: "write",
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
    /** Why the file is being written; recorded in the run journal. */
    reason: z.string().max(500).optional(),
  }),
  async execute(input, context) {
    const absolutePath = assertWritable(context, input.path);
    const relative = toPosix(relativeToRoot(context.repoRoot, absolutePath));
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > context.config.filesystem.maxFileSizeBytes) {
      throw new PathSecurityError(
        `Refusing to write ${bytes} bytes to "${relative}"; limit is ${context.config.filesystem.maxFileSizeBytes}`,
        relative,
      );
    }

    const existed = fs.existsSync(absolutePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, input.content, "utf8");

    return { path: relative, bytes, created: !existed, reason: input.reason ?? null };
  },
});

/* -------------------------------------------------------------------------- */
/* edit_file                                                                  */
/* -------------------------------------------------------------------------- */

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace an exact substring in a file. Fails when oldText is absent or ambiguous, so edits never land in the wrong place.",
  effect: "write",
  schema: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1).describe("Exact text to replace, including whitespace"),
    newText: z.string().describe("Replacement text"),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Replace every occurrence instead of requiring uniqueness"),
  }),
  async execute(input, context) {
    const absolutePath = assertWritable(context, input.path);
    const relative = toPosix(relativeToRoot(context.repoRoot, absolutePath));
    if (!fs.existsSync(absolutePath)) {
      throw new CommandFailedError(`Cannot edit missing file: ${relative}`, {
        exitCode: 1,
        stdout: "",
        stderr: "ENOENT",
        timedOut: false,
      });
    }

    const original = fs.readFileSync(absolutePath, "utf8");
    const occurrences = original.split(input.oldText).length - 1;

    if (occurrences === 0) {
      throw new CommandFailedError(`oldText not found in ${relative}`, {
        exitCode: 1,
        stdout: "",
        stderr: "NO_MATCH",
        timedOut: false,
      });
    }
    if (occurrences > 1 && input.replaceAll !== true) {
      throw new CommandFailedError(
        `oldText appears ${occurrences} times in ${relative}; add surrounding context or set replaceAll`,
        { exitCode: 1, stdout: "", stderr: "AMBIGUOUS_MATCH", timedOut: false },
      );
    }

    const updated =
      input.replaceAll === true
        ? original.split(input.oldText).join(input.newText)
        : original.replace(input.oldText, input.newText);

    fs.writeFileSync(absolutePath, updated, "utf8");
    return { path: relative, replacements: input.replaceAll === true ? occurrences : 1 };
  },
});

/* -------------------------------------------------------------------------- */
/* list_files                                                                 */
/* -------------------------------------------------------------------------- */

export const listFilesTool = defineTool({
  name: "list_files",
  description:
    "List repository files, skipping dependencies, build output and lockfiles. Optionally restrict to a subdirectory or glob.",
  effect: "read",
  schema: z.object({
    directory: z.string().optional().describe("Repository-relative subdirectory to start from"),
    glob: z
      .string()
      .optional()
      .describe("Glob filter applied to the repo-relative path, e.g. src/**/*.ts"),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  async execute(input, context) {
    const limit = input.limit ?? 400;
    const start = input.directory
      ? resolveInside(context.repoRoot, input.directory, { allowRoot: true })
      : context.repoRoot;

    const prefix = input.directory ? `${toPosix(input.directory).replace(/\/$/, "")}/` : "";
    const files = walkRepo(start, { maxFiles: 20_000 }).map((file) =>
      start === context.repoRoot ? file.relativePath : `${prefix}${file.relativePath}`,
    );

    const glob = input.glob;
    const filtered = glob ? files.filter((file) => matchesAnyGlob(file, [glob])) : files;
    return {
      total: filtered.length,
      truncated: filtered.length > limit,
      files: filtered.slice(0, limit),
    };
  },
});

/* -------------------------------------------------------------------------- */
/* search_code                                                                */
/* -------------------------------------------------------------------------- */

export interface CodeMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchCodeResult {
  query: string;
  total: number;
  files: string[];
  matches: CodeMatch[];
  truncated: boolean;
}

export interface SearchCodeInput {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  glob?: string;
  maxResults?: number;
}

export const searchCodeTool = defineTool({
  name: "search_code",
  description:
    "Search repository file contents for a string or regular expression and return matching lines with their locations.",
  effect: "read",
  schema: z.object({
    query: z.string().min(1),
    regex: z.boolean().optional().describe("Treat the query as a regular expression"),
    caseSensitive: z.boolean().optional(),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. src/**/*.ts"),
    maxResults: z.number().int().min(1).max(500).optional(),
  }),
  async execute(input, context) {
    return searchCode(context, input);
  },
});

/**
 * Literal-string and regex content search. Implemented in-process rather than
 * shelling out to ripgrep so it behaves identically inside and outside the
 * sandbox, and so results can be truncated deterministically.
 */
export async function searchCode(
  context: ToolContext,
  input: SearchCodeInput,
): Promise<SearchCodeResult> {
  const maxResults = input.maxResults ?? 100;
  let matcher: RegExp;
  try {
    matcher = input.regex
      ? new RegExp(input.query, input.caseSensitive ? "g" : "gi")
      : new RegExp(
          input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          input.caseSensitive ? "g" : "gi",
        );
  } catch (error) {
    throw new CommandFailedError(
      `Invalid search pattern: ${input.query}`,
      { exitCode: 1, stdout: "", stderr: String(error), timedOut: false },
      { cause: error },
    );
  }

  const glob = input.glob;
  const candidateFiles = walkRepo(context.repoRoot, { maxFiles: 20_000 }).filter((file) => {
    if (!isProbablyTextFile(file.absolutePath)) return false;
    if (glob && !matchesAnyGlob(file.relativePath, [glob])) return false;
    return true;
  });

  const matches: CodeMatch[] = [];
  const matchedFiles = new Set<string>();
  let truncated = false;

  for (const file of candidateFiles) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = readTextFile(context.repoRoot, file.relativePath, {
        maxBytes: context.config.filesystem.maxFileSizeBytes,
      }).content;
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      matcher.lastIndex = 0;
      const found = matcher.exec(line);
      if (!found) continue;
      matchedFiles.add(file.relativePath);
      matches.push({
        path: file.relativePath,
        line: index + 1,
        column: found.index + 1,
        text: truncate(line.trim(), 240, "…"),
      });
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
  }

  return {
    query: input.query,
    total: matches.length,
    files: [...matchedFiles].sort(),
    matches,
    truncated,
  };
}
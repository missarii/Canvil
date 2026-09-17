/**
 * Git tools: status, diff, log.
 *
 * These are read-only metadata reads, executed directly rather than through the
 * sandbox: they run no repository code, and routing them through a container
 * would only add latency. Mutating git operations are deliberately *not*
 * exposed — committing is the user's decision (see the approval layer).
 */

import { z } from "zod";
import { defineTool } from "../types.js";
import { ExternalServiceError } from "../../util/errors.js";
import type { Logger } from "../../util/logger.js";
import { resolveInside } from "../../util/paths.js";
import { sanitizedEnvironment } from "../../sandbox/policy.js";
import { runProcess } from "../../sandbox/process.js";
import { truncateMiddle } from "../../util/text.js";

export interface GitRunOptions {
  repoRoot: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  available: boolean;
}

/**
 * Run a read-only git command in the repository root.
 *
 * `available: false` means git is not installed or the directory is not a
 * repository; callers degrade gracefully instead of failing a whole run.
 */
export async function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
  const outcome = await runProcess({
    file: "git",
    args,
    cwd: options.repoRoot,
    env: sanitizedEnvironment(),
    timeoutMs: options.timeoutMs ?? 20_000,
    maxOutputBytes: options.maxOutputBytes ?? 200_000,
  });

  if (outcome.spawnError) {
    return { exitCode: null, stdout: "", stderr: outcome.spawnError, available: false };
  }
  const notARepo = outcome.exitCode !== 0 && /not a git repository/i.test(outcome.stderr);
  return {
    exitCode: outcome.exitCode,
    stdout: truncateMiddle(outcome.stdout, 200_000),
    stderr: truncateMiddle(outcome.stderr, 20_000),
    available: !notARepo,
  };
}

export interface GitFileChange {
  status: string;
  path: string;
  originalPath?: string;
}

/** Parse `git status --porcelain=v1 -z` into structured changes. */
export function parsePorcelainStatus(raw: string): GitFileChange[] {
  const changes: GitFileChange[] = [];
  const records = raw.split("\0").filter((record) => record.length > 0);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2).trim() || "?";
    const filePath = record.slice(3);
    const change: GitFileChange = { status, path: filePath };
    // Renames and copies carry the original path in the following NUL record.
    if ((status.startsWith("R") || status.startsWith("C")) && records[index + 1]) {
      change.originalPath = records[index + 1];
      index += 1;
    }
    changes.push(change);
  }
  return changes;
}

export interface GitState {
  available: boolean;
  isRepository: boolean;
  branch: string | null;
  changes: GitFileChange[];
  /** True when the working tree has no modifications. */
  clean: boolean;
}

/** Full, structured repository state used by the review and report steps. */
export async function readGitState(options: GitRunOptions): Promise<GitState> {
  const insideWorkTree = await runGit(["rev-parse", "--is-inside-work-tree"], options);
  if (!insideWorkTree.available) {
    return { available: false, isRepository: false, branch: null, changes: [], clean: true };
  }
  if (insideWorkTree.exitCode !== 0) {
    return { available: true, isRepository: false, branch: null, changes: [], clean: true };
  }

  const [branchResult, statusResult] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], options),
    runGit(["status", "--porcelain=v1", "-z"], options),
  ]);

  const changes = parsePorcelainStatus(statusResult.stdout);
  return {
    available: true,
    isRepository: true,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
    changes,
    clean: changes.length === 0,
  };
}

export const gitStatusTool = defineTool({
  name: "git_status",
  description: "Show the current branch and working tree changes as structured records.",
  effect: "read",
  schema: z.object({}),
  async execute(_input, context) {
    return readGitState({ repoRoot: context.repoRoot });
  },
});

export const gitDiffTool = defineTool({
  name: "git_diff",
  description:
    "Show the unified diff of the working tree (or of a single path). Use this to review what changed before reporting.",
  effect: "read",
  schema: z.object({
    path: z.string().optional().describe("Limit the diff to one repository-relative path"),
    staged: z.boolean().optional().describe("Diff the index instead of the working tree"),
    maxChars: z.number().int().min(500).max(200_000).optional(),
  }),
  async execute(input, context) {
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (input.staged) args.push("--cached");
    if (input.path) {
      args.push("--", resolveInside(context.repoRoot, input.path));
    }
    const result = await runGit(args, {
      repoRoot: context.repoRoot,
      maxOutputBytes: input.maxChars ?? 200_000,
    });
    if (!result.available) throw new ExternalServiceError("git is not available", "git");
    return {
      exitCode: result.exitCode,
      diff: result.stdout,
      empty: result.stdout.trim().length === 0,
    };
  },
});

export const gitLogTool = defineTool({
  name: "git_log",
  description:
    "Show recent commits (hash, date, author, subject) to understand recent project history.",
  effect: "read",
  schema: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    path: z.string().optional().describe("Limit history to one repository-relative path"),
  }),
  async execute(input, context) {
    const limit = input.limit ?? 20;
    const args = ["log", `-n${limit}`, "--date=short", "--pretty=format:%h%x09%ad%x09%an%x09%s"];
    if (input.path) args.push("--", input.path);
    const result = await runGit(args, { repoRoot: context.repoRoot, maxOutputBytes: 100_000 });
    if (!result.available) throw new ExternalServiceError("git is not available", "git");

    const commits = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [hash = "", date = "", author = "", ...rest] = line.split("\t");
        return { hash, date, author, subject: rest.join("\t") };
      });
    return { commits, count: commits.length };
  },
});

/** Convenience for nodes that only need the list of modified paths. */
export async function listChangedPaths(options: GitRunOptions, logger?: Logger): Promise<string[]> {
  const state = await readGitState(options);
  if (!state.available) logger?.debug("git unavailable; skipping change list");
  return state.changes.map((change) => change.path);
}
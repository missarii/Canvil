/**
 * Terminal tools: `run_command` and `run_tests`.
 *
 * Both go through the configured executor, which applies the command allowlist
 * and (by default) runs inside the Docker sandbox. Failures are returned as data
 * rather than thrown, because the agent's fix loop needs the output more than it
 * needs an exception.
 */

import { z } from "zod";
import { defineTool } from "../types.js";
import type { CommandResult } from "../types.js";

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a shell command in the project. The command must match the allowlist in config/canvil.config.json and runs inside the sandbox.",
  effect: "execute",
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Repository-relative working directory"),
    timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
    /** Why this command is needed; recorded in the run journal. */
    reason: z.string().max(300).optional(),
  }),
  async execute(input, context) {
    const result = await context.executor.run({
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    return { ...result, reason: input.reason ?? null };
  },
});

export interface TestRunOutcome {
  command: string;
  /** True when the command exited 0. */
  passed: boolean;
  result: CommandResult;
  /** Best-effort structured summary parsed from common runner output. */
  summary: TestSummary;
  /** Set when no test command could be determined for this project. */
  skippedReason?: string;
}

export interface TestSummary {
  framework: string | null;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  durationMs: number | null;
  /** Failing test names, used to steer the fix step. */
  failures: string[];
}

/**
 * Parse the summary line of the common test runners. Anything unrecognised
 * yields nulls rather than a wrong number: a fabricated pass count is worse
 * than no count.
 */
export function parseTestSummary(stdout: string, stderr: string): TestSummary {
  const output = `${stdout}\n${stderr}`;
  const summary: TestSummary = {
    framework: null,
    total: null,
    passed: null,
    failed: null,
    skipped: null,
    durationMs: null,
    failures: [],
  };

  const vitest = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(?:(\d+)\s+skipped\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/.exec(
    output,
  );
  if (vitest) {
    summary.framework = "vitest";
    summary.failed = vitest[1] ? Number(vitest[1]) : 0;
    summary.skipped = vitest[2] ? Number(vitest[2]) : 0;
    summary.passed = Number(vitest[3]);
    summary.total = Number(vitest[4]);
  }

  const jest = /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/.exec(
    output,
  );
  if (!summary.framework && jest) {
    summary.framework = "jest";
    summary.failed = jest[1] ? Number(jest[1]) : 0;
    summary.skipped = jest[2] ? Number(jest[2]) : 0;
    summary.passed = Number(jest[3]);
    summary.total = Number(jest[4]);
  }

  const pytest = /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/.exec(output);
  if (!summary.framework && pytest) {
    summary.framework = "pytest";
    summary.passed = Number(pytest[1]);
    summary.failed = pytest[2] ? Number(pytest[2]) : 0;
    summary.skipped = pytest[3] ? Number(pytest[3]) : 0;
    summary.total = summary.passed + summary.failed + summary.skipped;
  }

  const goOk = /^ok\s+\S+/m.exec(output);
  if (!summary.framework && goOk) summary.framework = "go";

  if (!summary.framework && /test result: (ok|FAILED)/.test(output)) {
    summary.framework = "cargo";
  }

  const duration = /(?:Duration|Time):\s*([\d.]+)\s*s/i.exec(output);
  if (duration?.[1]) summary.durationMs = Math.round(Number(duration[1]) * 1000);

  for (const match of output.matchAll(/^\s*(?:✕|×|FAIL|FAILED)\s+(.+)$/gm)) {
    const name = match[1]?.trim();
    if (name && name.length < 300) summary.failures.push(name);
  }

  summary.failures = [...new Set(summary.failures)].slice(0, 25);
  return summary;
}

export const runTestsTool = defineTool({
  name: "run_tests",
  description:
    "Run the project's test command (detected from package.json scripts or the ecosystem default) inside the sandbox and return a parsed summary.",
  effect: "execute",
  schema: z.object({
    /** Override the detected command when a narrower suite is wanted. */
    command: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(5_000).max(1_800_000).optional(),
  }),
  async execute(input, context): Promise<TestRunOutcome> {
    const profile = context.profile;
    const command = input.command ?? profile?.commands.test;

    if (!command) {
      return {
        command: "",
        passed: false,
        result: {
          command: "",
          isolation: "none",
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          durationMs: 0,
          truncated: false,
        },
        summary: parseTestSummary("", ""),
        skippedReason:
          "No test command detected. Add a `test` script to package.json, or pass an explicit command.",
      };
    }

    const result = await context.executor.run({
      command,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });

    return {
      command,
      passed: result.exitCode === 0,
      result,
      summary: parseTestSummary(result.stdout, result.stderr),
    };
  },
});
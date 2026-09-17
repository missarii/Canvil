/**
 * `verify` node: run the project's own tests and build.
 *
 * Verification is deliberately deterministic. The model does not get to decide
 * whether the change works — the repository's own tooling does, and the exit
 * code is the answer.
 */

import type { TestRunRecord } from "../state.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";
import { truncate } from "../../util/text.js";
import { toError } from "../../util/errors.js";
import { toolContextFor, type AgentDeps } from "./deps.js";

interface RunTestsOutput {
  command: string;
  passed: boolean;
  skippedReason?: string;
  result: { exitCode: number | null; stdout: string; stderr: string; durationMs: number };
  summary: {
    framework: string | null;
    total: number | null;
    passed: number | null;
    failed: number | null;
    skipped: number | null;
    durationMs: number | null;
    failures: string[];
  };
}

interface RunCommandOutput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  isolation: "docker" | "local" | "none";
}

export function createVerifyNode(deps: AgentDeps) {
  return async function verify(state: CanvilStateType): Promise<CanvilStateUpdate> {
    const toolContext = toolContextFor(deps, state);
    const profile = state.profile;

    if (!profile?.commands.test && !profile?.commands.build && !profile?.commands.typecheck) {
      return {
        verificationPassed: null,
        verificationFeedback:
          "No test, build or typecheck command could be determined for this project.",
        status: "reviewing",
        log: logLine("verify: skipped (no command detected)"),
      };
    }

    const useTests = Boolean(profile?.commands.test);
    const command = profile?.commands.test ?? profile?.commands.build ?? profile?.commands.typecheck;

    let record: TestRunRecord;
    try {
      if (useTests) {
        const output = (await deps.tools.invoke("run_tests", {}, toolContext)) as RunTestsOutput;
        if (output.skippedReason) {
          return {
            verificationPassed: null,
            verificationFeedback: output.skippedReason,
            status: "reviewing",
            log: logLine(`verify: skipped (${output.skippedReason})`),
          };
        }
        record = {
          command: output.command,
          passed: output.passed,
          exitCode: output.result.exitCode,
          durationMs: output.result.durationMs,
          summaryText: describeSummary(output.summary.framework, output.summary, profile?.commands.test),
          failures: output.summary.failures,
          stdout: truncate(output.result.stdout, 20_000),
          stderr: truncate(output.result.stderr, 10_000),
        };
      } else {
        const output = (await deps.tools.invoke(
          "run_command",
          { command: command ?? "", reason: "verification" },
          toolContext,
        )) as RunCommandOutput;
        record = {
          command: output.command,
          passed: output.exitCode === 0,
          exitCode: output.exitCode,
          durationMs: output.durationMs,
          summaryText: `${profile?.commands.build ? "build" : "typecheck"} exited ${output.exitCode ?? "null"}${output.timedOut ? " (timed out)" : ""}`,
          failures: [],
          stdout: truncate(output.stdout, 20_000),
          stderr: truncate(output.stderr, 10_000),
        };
      }
    } catch (error) {
      const message = toError(error).message;
      record = {
        command: command ?? "(unknown)",
        passed: false,
        exitCode: null,
        durationMs: 0,
        summaryText: `Verification could not run: ${message}`,
        failures: [],
        stdout: "",
        stderr: message,
      };
    }

    deps.journal.record("test", record.summaryText, {
      command: record.command,
      exitCode: record.exitCode,
      failures: record.failures,
    });

    const feedback = record.passed
      ? null
      : [
          `Verification command failed: ${record.command}`,
          record.summaryText,
          record.failures.length > 0
            ? `Failing tests:\n${record.failures.map((failure) => `- ${failure}`).join("\n")}`
            : "",
          `--- stdout (tail) ---\n${tail(record.stdout, 6_000)}`,
          `--- stderr (tail) ---\n${tail(record.stderr, 3_000)}`,
        ]
          .filter((part) => part.length > 0)
          .join("\n");

    return {
      testRuns: [record],
      verificationPassed: record.passed,
      verificationFeedback: feedback,
      status: record.passed ? "reviewing" : "diagnosing",
      log: logLine(
        `verify: ${record.passed ? "passed" : "failed"} — ${record.command} (exit ${record.exitCode ?? "null"})`,
      ),
    };
  };
}

function describeSummary(
  framework: string | null,
  summary: RunTestsOutput["summary"],
  command: string | undefined,
): string {
  if (summary.total === null) {
    return `${framework ?? command ?? "tests"} finished; the runner did not print a parsable summary.`;
  }
  return (
    `${framework ?? "tests"}: ${summary.passed ?? 0} passed, ${summary.failed ?? 0} failed` +
    (summary.skipped ? `, ${summary.skipped} skipped` : "") +
    `, ${summary.total} total`
  );
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…[${text.length - maxChars} chars omitted]\n${text.slice(-maxChars)}`;
}
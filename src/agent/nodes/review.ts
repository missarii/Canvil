/**
 * `review` node: security scan plus a model review of the final diff.
 *
 * The security scan is deterministic and always runs; the model review is
 * advisory. That ordering matters: a rule finding is a fact about the code, so it
 * must not depend on a model deciding to mention it.
 */

import { scanFilesForSecurity, summarizeSecurityReport } from "../../security/scanner.js";
import { runGit, readGitState } from "../../tools/git/index.js";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "../prompts.js";
import { reviewSchema, SCHEMA_NAMES, type ReviewResult } from "../schemas.js";
import { promptContextFor, type AgentDeps } from "./deps.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";
import { truncate } from "../../util/text.js";
import { toError } from "../../util/errors.js";

export function createReviewNode(deps: AgentDeps) {
  return async function review(state: CanvilStateType): Promise<CanvilStateUpdate> {
    const repoRoot = deps.toolContext.repoRoot;
    const trace: string[] = [];

    // 1. Which files did this run actually touch?
    const applied = state.edits.filter((edit) => edit.applied).map((edit) => edit.path);
    const gitState = await readGitState({ repoRoot });
    const changed = [...new Set([...applied, ...gitState.changes.map((change) => change.path)])];
    const reviewable = changed.filter((file) => !file.startsWith(".canvil/"));

    // 2. Deterministic security pass over those files.
    const security =
      reviewable.length > 0
        ? scanFilesForSecurity({
            repoRoot,
            files: reviewable,
            maxFileBytes: deps.toolContext.config.filesystem.maxFileSizeBytes,
          })
        : null;

    if (security) {
      const summary = summarizeSecurityReport(security);
      trace.push(
        `security: ${summary.total} finding(s) (${summary.high} high, ${summary.medium} medium, ${summary.low} low)`,
      );
      deps.journal.record("security", `Security scan: ${summary.total} finding(s)`, {
        high: summary.high,
        medium: summary.medium,
        low: summary.low,
        byRule: summary.byRule,
      });
    }

    // 3. Read the diff so the review is about what actually changed.
    const diffResult = await runGit(["diff", "--no-color", "--no-ext-diff"], {
      repoRoot,
      maxOutputBytes: 200_000,
    });
    const diff = truncate(diffResult.stdout, 60_000);
    const lastRun = state.testRuns[state.testRuns.length - 1];
    const testSummary = lastRun
      ? `${lastRun.summaryText} (exit ${lastRun.exitCode ?? "null"})`
      : "No verification command was run for this change.";

    // 4. Model review — advisory, and skippable when there is no diff.
    let result: ReviewResult | null = null;
    if (diff.trim().length > 0) {
      try {
        result = await deps.model.structured({
          name: SCHEMA_NAMES.review,
          schema: reviewSchema,
          prompt: {
            system: REVIEW_SYSTEM_PROMPT,
            user: buildReviewPrompt(promptContextFor(state), diff, testSummary),
          },
        });
        trace.push(`review: ${result.verdict}`);
        deps.journal.record("review", `Review verdict: ${result.verdict}`, {
          summary: result.summary,
          blocking: result.comments.filter((comment) => comment.severity === "blocking").length,
          followsConventions: result.followsConventions,
        });
      } catch (error) {
        const message = toError(error).message;
        deps.logger.warn("Model review failed", { error: message });
        trace.push(`review: skipped (${message})`);
        deps.journal.record("review", `Model review unavailable: ${message}`, {});
      }
    } else {
      trace.push("review: no diff to review");
    }

    const blocking = result?.comments.filter((comment) => comment.severity === "blocking").length ?? 0;
    const summary = security ? summarizeSecurityReport(security) : null;
    const hasFindings =
      blocking > 0 ||
      (result !== null && result.verdict === "request-changes") ||
      (summary !== null && !summary.acceptable);

    if (summary && !summary.acceptable) {
      trace.push("security findings at medium severity or above require attention");
    }

    return {
      security,
      review: result,
      status: hasFindings ? "completed-with-findings" : "completed",
      log: [...logLine("review complete"), ...trace],
    };
  };
}
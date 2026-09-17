/**
 * Run report.
 *
 * The report is the product surface: it turns a graph execution into something a
 * reviewer can act on — what was proposed, what changed, what was verified, what
 * remains uncertain, and where the evidence came from.
 */

import { groupByTier } from "../knowledge/sources/ranking.js";
import { summarizeSecurityReport, type SecurityFinding } from "../security/scanner.js";
import type { AppliedEdit, CommandRecord, RunStatus, TestRunRecord } from "./state.js";
import type { ResearchBundle } from "../knowledge/types.js";
import type { ImplementationPlan, ReviewResult } from "./schemas.js";
import type { ProjectProfile } from "../project/types.js";
import { describeProfile } from "../project/types.js";

export interface RunReport {
  runId: string;
  task: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  model: string;
  sandboxMode: string;
  verification: string;
  iterations: number;
  project: {
    name: string;
    root: string;
    summary: string;
    commands: ProjectProfile["commands"];
  } | null;
  research: {
    queries: string[];
    sourceCount: number;
    byTier: Array<{ tier: number; type: string; count: number; top: string[] }>;
    findings: Array<{
      question: string;
      answer: string;
      confidence: string;
      sources: string[];
      caveats?: string[];
    }>;
    limitations: string[];
  } | null;
  plan: ImplementationPlan | null;
  edits: {
    applied: AppliedEdit[];
    refused: AppliedEdit[];
  };
  commands: CommandRecord[];
  testRuns: TestRunRecord[];
  security: {
    total: number;
    high: number;
    medium: number;
    low: number;
    findings: SecurityFinding[];
  } | null;
  review: ReviewResult | null;
  /** Things a human should look at before merging. */
  followUps: string[];
  journalPath: string;
  log: string[];
}

export interface BuildReportInput {
  runId: string;
  task: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  model: string;
  sandboxMode: string;
  verification: string;
  iterations: number;
  profile: ProjectProfile | null;
  research: ResearchBundle | null;
  plan: ImplementationPlan | null;
  edits: AppliedEdit[];
  commands: CommandRecord[];
  testRuns: TestRunRecord[];
  securityFindings: SecurityFinding[] | null;
  review: ReviewResult | null;
  journalPath: string;
  log: string[];
}

export function buildRunReport(input: BuildReportInput): RunReport {
  const started = Date.parse(input.startedAt);
  const finished = Date.parse(input.finishedAt);

  return {
    runId: input.runId,
    task: input.task,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : 0,
    model: input.model,
    sandboxMode: input.sandboxMode,
    verification: input.verification,
    iterations: input.iterations,
    project: input.profile
      ? {
          name: input.profile.name,
          root: input.profile.root,
          summary: describeProfile(input.profile),
          commands: input.profile.commands,
        }
      : null,
    research: input.research
      ? {
          queries: input.research.queries,
          sourceCount: input.research.sources.length,
          byTier: groupByTier(input.research.sources).map((group) => ({
            tier: group.tier,
            type: group.type,
            count: group.sources.length,
            top: group.sources.slice(0, 3).map((source) => source.title),
          })),
          findings: input.research.findings.map((finding) => ({
            question: finding.question,
            answer: finding.answer,
            confidence: finding.confidence,
            sources: finding.sources,
            ...(finding.caveats && finding.caveats.length > 0 ? { caveats: finding.caveats } : {}),
          })),
          limitations: input.research.limitations,
        }
      : null,
    plan: input.plan,
    edits: {
      applied: input.edits.filter((edit) => edit.applied),
      refused: input.edits.filter((edit) => !edit.applied),
    },
    commands: input.commands,
    testRuns: input.testRuns,
    security: input.securityFindings ? securityBlockFrom(input.securityFindings) : null,
    review: input.review,
    followUps: buildFollowUps(input),
    journalPath: input.journalPath,
    log: input.log,
  };
}

function securityBlockFrom(findings: SecurityFinding[]): RunReport["security"] {
  const summary = summarizeSecurityReport({
    findings,
    scannedFiles: [],
    skippedFiles: [],
    rulesEvaluated: 0,
  });
  return {
    total: summary.total,
    high: summary.high,
    medium: summary.medium,
    low: summary.low,
    findings,
  };
}

function buildFollowUps(input: BuildReportInput): string[] {
  const followUps: string[] = [];

  if (input.status === "failed") {
    followUps.push("Verification did not pass. Inspect the diff before doing anything else.");
  }
  if (input.status === "blocked") {
    followUps.push("The agent reported it was blocked and stopped without making changes.");
  }
  if (input.status === "completed-with-findings") {
    followUps.push("The change was verified but has unresolved findings — review them below.");
  }
  for (const edit of input.edits.filter((item) => !item.applied)) {
    followUps.push(`Operation not applied on ${edit.path}: ${edit.reason ?? "unknown reason"}`);
  }
  if (input.securityFindings && input.securityFindings.length > 0) {
    const high = input.securityFindings.filter((finding) => finding.severity === "high").length;
    if (high > 0) followUps.push(`${high} high-severity security finding(s) must be resolved.`);
  }
  for (const comment of input.review?.comments ?? []) {
    if (comment.severity === "blocking") {
      followUps.push(`Blocking review comment in ${comment.file}: ${comment.comment}`);
    }
  }
  for (const limitation of input.research?.limitations ?? []) {
    followUps.push(`Research limitation: ${limitation}`);
  }
  const failures = input.testRuns.filter((run) => !run.passed);
  const lastFailure = failures[failures.length - 1];
  if (lastFailure) {
    followUps.push(
      `${failures.length} verification run(s) failed; the last was: ${lastFailure.summaryText}`,
    );
  }
  return [...new Set(followUps)];
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const STATUS_MARK: Record<RunStatus, string> = {
  pending: "·",
  inspecting: "·",
  researching: "·",
  planning: "·",
  coding: "·",
  verifying: "·",
  diagnosing: "·",
  reviewing: "·",
  completed: "OK",
  "completed-with-findings": "!",
  failed: "FAIL",
  blocked: "BLOCKED",
};

export function renderConsoleReport(report: RunReport): string {
  const lines: string[] = [];
  const seconds = (report.durationMs / 1000).toFixed(1);

  lines.push(`Canvil run ${report.runId}`);
  lines.push(`Status:   ${STATUS_MARK[report.status]} ${report.status}`);
  lines.push(`Task:     ${report.task}`);
  lines.push(`Model:    ${report.model}`);
  lines.push(`Sandbox:  ${report.sandboxMode}`);
  lines.push(`Duration: ${seconds}s over ${report.iterations} coding iteration(s)`);
  if (report.project) lines.push(`Project:  ${report.project.name}`);

  lines.push("");
  lines.push(`Files changed (${report.edits.applied.length}):`);
  if (report.edits.applied.length === 0) lines.push("  (none)");
  for (const edit of report.edits.applied) lines.push(`  ${edit.action.padEnd(9)} ${edit.path}`);

  if (report.edits.refused.length > 0) {
    lines.push(`Operations refused (${report.edits.refused.length}):`);
    for (const edit of report.edits.refused) {
      lines.push(`  ${edit.path}: ${edit.reason ?? "unknown reason"}`);
    }
  }

  lines.push("");
  lines.push(`Verification (${report.testRuns.length} run(s)):`);
  if (report.testRuns.length === 0) lines.push(`  not run — ${report.verification}`);
  for (const run of report.testRuns) {
    lines.push(`  ${run.passed ? "PASS" : "FAIL"} ${run.command} — ${run.summaryText}`);
  }

  if (report.security) {
    lines.push("");
    lines.push(
      `Security: ${report.security.total} finding(s) — ${report.security.high} high, ${report.security.medium} medium, ${report.security.low} low`,
    );
    for (const finding of report.security.findings.slice(0, 8)) {
      lines.push(
        `  [${finding.severity}] ${finding.file}:${finding.line} ${finding.title} (${finding.cwe})`,
      );
    }
    if (report.security.findings.length > 8) {
      lines.push(`  … ${report.security.findings.length - 8} more in the journal`);
    }
  }

  if (report.review) {
    lines.push("");
    lines.push(`Review: ${report.review.verdict} — ${report.review.summary}`);
    for (const comment of report.review.comments.slice(0, 6)) {
      lines.push(`  [${comment.severity}] ${comment.file}: ${comment.comment}`);
    }
  }

  if (report.research) {
    lines.push("");
    lines.push(
      `Research: ${report.research.queries.length} query/queries, ${report.research.sourceCount} source(s)`,
    );
    for (const group of report.research.byTier) {
      lines.push(`  tier ${group.tier} (${group.type}): ${group.count}`);
    }
    for (const finding of report.research.findings.slice(0, 5)) {
      lines.push(`  [${finding.confidence}] ${finding.question} → ${finding.answer.slice(0, 160)}`);
    }
  }

  if (report.followUps.length > 0) {
    lines.push("");
    lines.push("Before you merge:");
    for (const item of report.followUps) lines.push(`  - ${item}`);
  }

  lines.push("");
  lines.push(`Journal: ${report.journalPath}`);
  return lines.join("\n");
}

export function renderMarkdownReport(report: RunReport): string {
  const sections: string[] = [];
  sections.push(`# Canvil run ${report.runId}`);
  sections.push(
    [
      `- **Status**: ${report.status}`,
      `- **Task**: ${report.task}`,
      `- **Model**: ${report.model}`,
      `- **Sandbox**: ${report.sandboxMode}`,
      `- **Duration**: ${(report.durationMs / 1000).toFixed(1)}s`,
      `- **Iterations**: ${report.iterations}`,
    ].join("\n"),
  );

  if (report.project) {
    sections.push(`## Project\n\`\`\`\n${report.project.summary}\n\`\`\``);
  }

  if (report.plan) {
    sections.push(
      `## Plan\n${report.plan.summary}\n\n${report.plan.steps
        .map(
          (step, index) =>
            `${index + 1}. ${step.description}\n   - files: ${step.files.join(", ") || "n/a"}`,
        )
        .join("\n")}`,
    );
    if (report.plan.assumptions.length > 0) {
      sections.push(`### Assumptions\n${report.plan.assumptions.map((item) => `- ${item}`).join("\n")}`);
    }
  }

  sections.push(
    `## Changes\n${
      report.edits.applied.length === 0
        ? "_No files were modified._"
        : report.edits.applied.map((edit) => `- ${edit.action} \`${edit.path}\``).join("\n")
    }`,
  );
  if (report.edits.refused.length > 0) {
    sections.push(
      `### Refused operations\n${report.edits.refused
        .map((edit) => `- \`${edit.path}\`: ${edit.reason ?? "unknown"}`)
        .join("\n")}`,
    );
  }

  sections.push(
    `## Verification\n${
      report.testRuns.length === 0
        ? `_Not run: ${report.verification}_`
        : report.testRuns
            .map(
              (run) =>
                `- ${run.passed ? "PASS" : "FAIL"} \`${run.command}\` — ${run.summaryText}` +
                (run.failures.length > 0
                  ? `\n  - failing: ${run.failures.slice(0, 5).join(", ")}`
                  : ""),
            )
            .join("\n")
    }`,
  );

  if (report.research) {
    sections.push(
      `## Research\nQueries:\n${
        report.research.queries.map((query) => `- \`${query}\``).join("\n") || "- (none)"
      }\n\nSources by trust tier:\n${report.research.byTier
        .map((group) => `- tier ${group.tier} (${group.type}): ${group.count}`)
        .join("\n")}\n\n` +
        (report.research.findings.length > 0
          ? `Findings:\n${report.research.findings
              .map(
                (finding) =>
                  `- **[${finding.confidence}]** ${finding.question}\n  ${finding.answer}\n  sources: ${
                    finding.sources.join(", ") || "none"
                  }`,
              )
              .join("\n")}`
          : "_No findings were produced._") +
        (report.research.limitations.length > 0
          ? `\n\nLimitations:\n${report.research.limitations.map((item) => `- ${item}`).join("\n")}`
          : ""),
    );
  }

  if (report.security) {
    sections.push(
      `## Security\n${report.security.total} finding(s): ${report.security.high} high, ${report.security.medium} medium, ${report.security.low} low.\n\n` +
        (report.security.findings.length > 0
          ? report.security.findings
              .map(
                (finding) =>
                  `- **[${finding.severity}]** \`${finding.file}:${finding.line}\` ${finding.title} (${finding.owasp}, ${finding.cwe})\n  \`${finding.excerpt}\`\n  → ${finding.recommendation}`,
              )
              .join("\n")
          : "_No findings._"),
    );
  }

  if (report.review) {
    sections.push(
      `## Review (${report.review.verdict})\n${report.review.summary}\n\n` +
        (report.review.comments.length > 0
          ? report.review.comments
              .map((comment) => `- [${comment.severity}] \`${comment.file}\`: ${comment.comment}`)
              .join("\n")
          : "_No comments._") +
        `\n\nFollows existing conventions: ${report.review.followsConventions ? "yes" : "no"}`,
    );
  }

  if (report.followUps.length > 0) {
    sections.push(`## Before you merge\n${report.followUps.map((item) => `- ${item}`).join("\n")}`);
  }

  sections.push(`## Trace\n\`\`\`\n${report.log.join("\n")}\n\`\`\``);
  sections.push(`_Journal: ${report.journalPath}_`);
  return sections.join("\n\n");
}
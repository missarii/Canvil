/**
 * Graph state.
 *
 * A single, explicit state object makes the agent's behaviour inspectable: at
 * any checkpoint you can see the profile that was built, the plan that was
 * agreed, every edit that was applied, and why a loop continued or stopped.
 *
 * Reducers are chosen per field: append-only lists accumulate (edits, commands,
 * test runs, log lines), while "current view" fields are replaced so the latest
 * value always wins.
 */

import { Annotation } from "@langchain/langgraph";
import type { ProjectProfile } from "../project/types.js";
import type { ContextFile, ContextPack } from "../project/analyzer.js";
import type { ResearchBundle } from "../knowledge/types.js";
import type { SecurityReport } from "../security/scanner.js";
import type {
  CodeResponse,
  Diagnosis,
  ImplementationPlan,
  ReviewResult,
} from "./schemas.js";

export type RunStatus =
  | "pending"
  | "inspecting"
  | "researching"
  | "planning"
  | "coding"
  | "verifying"
  | "diagnosing"
  | "reviewing"
  | "completed"
  | "completed-with-findings"
  | "failed"
  | "blocked";

export interface AppliedEdit {
  path: string;
  action: "create" | "overwrite" | "edit";
  bytes: number;
  created: boolean;
  reason: string | null;
  /** False when the approval policy rejected the write. */
  applied: boolean;
}

export interface CommandRecord {
  command: string;
  exitCode: number | null;
  isolation: "docker" | "local" | "none";
  timedOut: boolean;
  durationMs: number;
  /** Truncated tail of the output, for the report and the fix loop. */
  output: string;
  reason: string | null;
  phase: "post-code" | "verification" | "research";
}

export interface TestRunRecord {
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  summaryText: string;
  failures: string[];
  stdout: string;
  stderr: string;
}

export interface ApprovalRequest {
  kind: "write" | "command";
  description: string;
  paths?: string[];
  command?: string;
}

/** Result of the human-in-the-loop gate; injected by the runner. */
export type ApprovalDecision = "approve" | "reject" | "approve-all";

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

const replace = <T>(_current: T, next: T): T => next;
const append = <T>(current: T[], next: T[]): T[] => [...current, ...next];

export const CanvilState = Annotation.Root({
  /** The user's task, verbatim. */
  task: Annotation<string>({ reducer: replace, default: () => "" }),

  /** Repository facts from the scanner. */
  profile: Annotation<ProjectProfile | null>({ reducer: replace, default: () => null }),

  /** Candidate files ranked for this task. */
  contextFiles: Annotation<ContextFile[]>({ reducer: replace, default: () => [] }),

  /** Budgeted file contents handed to the model, with provenance. */
  contextPack: Annotation<ContextPack | null>({ reducer: replace, default: () => null }),

  /** Focus queries from a failed attempt; consumed and cleared by `research`. */
  researchFocus: Annotation<string[]>({ reducer: replace, default: () => [] }),

  /** Accumulated research across all passes. */
  research: Annotation<ResearchBundle | null>({ reducer: replace, default: () => null }),

  plan: Annotation<ImplementationPlan | null>({ reducer: replace, default: () => null }),

  /** The most recent model-suggested change set. */
  lastCodeResponse: Annotation<CodeResponse | null>({ reducer: replace, default: () => null }),

  edits: Annotation<AppliedEdit[]>({ reducer: append, default: () => [] }),

  commands: Annotation<CommandRecord[]>({ reducer: append, default: () => [] }),

  testRuns: Annotation<TestRunRecord[]>({ reducer: append, default: () => [] }),

  /** Number of code->verify cycles completed. */
  iteration: Annotation<number>({ reducer: replace, default: () => 0 }),

  /** Whether the most recent verification passed. */
  verificationPassed: Annotation<boolean | null>({ reducer: replace, default: () => null }),

  /** Feedback handed to the next `code` pass (test/build failures). */
  verificationFeedback: Annotation<string | null>({ reducer: replace, default: () => null }),

  diagnosis: Annotation<Diagnosis | null>({ reducer: replace, default: () => null }),

  security: Annotation<SecurityReport | null>({ reducer: replace, default: () => null }),

  review: Annotation<ReviewResult | null>({ reducer: replace, default: () => null }),

  status: Annotation<RunStatus>({ reducer: replace, default: () => "pending" }),

  /** Human-readable trace, also mirrored into the run journal. */
  log: Annotation<string[]>({ reducer: append, default: () => [] }),

  /** When set, the graph stops and reports instead of continuing. */
  haltReason: Annotation<string | null>({ reducer: replace, default: () => null }),

  /** True when the write-approval gate rejected at least one edit. */
  editsRejected: Annotation<boolean>({ reducer: replace, default: () => false }),
});

export type CanvilStateType = typeof CanvilState.State;
export type CanvilStateUpdate = typeof CanvilState.Update;

/** Append a trace line to the state update. */
export function logLine(message: string): string[] {
  return [`${new Date().toISOString()} ${message}`];
}

/** Build a compact failure text for the fix loop and the review step. */
export function summarizeTestRun(run: TestRunRecord): string {
  const parts = [
    `command: ${run.command}`,
    `exit: ${run.exitCode ?? "null"}`,
    run.summaryText ? `summary: ${run.summaryText}` : "",
    run.failures.length > 0 ? `failures:\n${run.failures.map((f) => `- ${f}`).join("\n")}` : "",
  ].filter((part) => part.length > 0);
  return parts.join("\n");
}
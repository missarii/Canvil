/**
 * `finalize` node: close the run out honestly.
 *
 * The status written here is the claim the whole system stands behind, so it is
 * derived from evidence (did verification pass, were writes applied, are there
 * unresolved findings) rather than from what the model said it did.
 */

import { summarizeSecurityReport } from "../../security/scanner.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";
import type { AgentDeps } from "./deps.js";

export function createFinalizeNode(deps: AgentDeps) {
  return async function finalize(state: CanvilStateType): Promise<CanvilStateUpdate> {
    const appliedEdits = state.edits.filter((edit) => edit.applied);
    const securitySummary = state.security ? summarizeSecurityReport(state.security) : null;
    const blocking = state.review?.comments.filter((c) => c.severity === "blocking").length ?? 0;

    let status: CanvilStateType["status"] = state.status;
    const notes: string[] = [];

    if (state.haltReason) {
      notes.push(`halted: ${state.haltReason}`);
    } else if (state.verificationPassed === true) {
      status = blocking > 0 || (securitySummary && !securitySummary.acceptable)
        ? "completed-with-findings"
        : "completed";
      notes.push(
        `verified with ${state.testRuns[state.testRuns.length - 1]?.command ?? "the project's test command"}`,
      );
    } else if (state.verificationPassed === false) {
      status = "failed";
      notes.push(
        `verification still failing after ${state.iteration} iteration(s); the change is on disk and needs a human decision`,
      );
    } else if (appliedEdits.length === 0 && !deps.readOnly) {
      status = "failed";
      notes.push("no file was modified");
    }

    deps.journal.record("run-end", `Run finished with status ${status}`, {
      appliedEdits: appliedEdits.map((edit) => edit.path),
      iterations: state.iteration,
      verificationPassed: state.verificationPassed,
      securityFindings: securitySummary?.total ?? 0,
      blockingComments: blocking,
    });

    return {
      status,
      log: [...logLine(`finalize: ${status}`), ...notes],
    };
  };
}
/**
 * Graph routing.
 *
 * Routing is a pure function of state, which is what makes the loop auditable:
 * given a checkpoint you can replay why the graph went where it went. The budget
 * for fix attempts lives here, so a runaway loop is structurally impossible.
 */

import type { CanvilStateType } from "./state.js";
import type { AgentDeps } from "./nodes/deps.js";

export type PostVerifyRoute = "diagnose" | "review" | "finalize";
export type PostDiagnoseRoute = "research" | "code" | "finalize";

export interface Routers {
  afterVerify(state: CanvilStateType): PostVerifyRoute;
  afterDiagnose(state: CanvilStateType): PostDiagnoseRoute;
  afterResearch(state: CanvilStateType): "plan";
}

export function createRouters(deps: AgentDeps): Routers {
  const maxIterations = deps.toolContext.config.agent.maxIterations;

  return {
    /**
     * Passed verification -> review. Otherwise diagnose once more, unless the
     * iteration budget is spent or the run has already been halted.
     */
    afterVerify(state: CanvilStateType): PostVerifyRoute {
      if (state.verificationPassed === true) return "review";
      if (state.haltReason) return "finalize";
      if (state.iteration >= maxIterations) return "finalize";
      return "diagnose";
    },

    /**
     * A diagnosis either sends the agent back for focused research (when it says
     * knowledge is missing and the query budget allows) or straight to another
     * coding attempt.
     */
    afterDiagnose(state: CanvilStateType): PostDiagnoseRoute {
      if (state.haltReason) return "finalize";
      if (state.status === "failed") return "finalize";
      if (state.iteration >= maxIterations) return "finalize";
      if (state.researchFocus.length > 0) {
        const used = state.research?.queries.length ?? 0;
        if (used < deps.maxResearchQueries) return "research";
      }
      return "code";
    },

    /** After the initial research pass, always plan. */
    afterResearch(): "plan" {
      return "plan";
    },
  };
}

/**
 * Remaining fix attempts, used by the report to explain a failed run.
 */
export function remainingIterations(state: CanvilStateType, maxIterations: number): number {
  return Math.max(0, maxIterations - state.iteration);
}
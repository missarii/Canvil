/**
 * The Canvil graph.
 *
 * ```
 * START -> inspect -> research -> plan -> code -> verify
 *                                            |        ^
 *                            (fail, budget left)      |
 *                                            v        |
 *                                         diagnose ---+--> code
 *                                            |
 *                                   (needs knowledge)
 *                                            v
 *                                         research
 *
 * verify (pass) -> review -> finalize -> END
 * ```
 *
 * LangGraph is used for exactly what it is good at here: shared typed state,
 * conditional branching, a bounded retry loop, and the option to add
 * checkpointing or interrupts without restructuring the nodes.
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import { CanvilState } from "./state.js";
import { createInspectNode } from "./nodes/inspect.js";
import { createResearchNode } from "./nodes/research.js";
import { createPlanNode } from "./nodes/plan.js";
import { createCodeNode } from "./nodes/code.js";
import { createVerifyNode } from "./nodes/verify.js";
import { createDiagnoseNode } from "./nodes/diagnose.js";
import { createReviewNode } from "./nodes/review.js";
import { createFinalizeNode } from "./nodes/finalize.js";
import { createRouters } from "./routing.js";
import type { AgentDeps } from "./nodes/deps.js";

export const NODE_NAMES = {
  inspect: "inspect",
  research: "research",
  plan: "plan",
  code: "code",
  verify: "verify",
  diagnose: "diagnose",
  review: "review",
  finalize: "finalize",
} as const;

/** Build and compile the graph. Deps are injected, so tests control everything. */
export function buildCanvilGraph(deps: AgentDeps) {
  const routers = createRouters(deps);

  const graph = new StateGraph(CanvilState)
    .addNode(NODE_NAMES.inspect, createInspectNode(deps))
    .addNode(NODE_NAMES.research, createResearchNode(deps))
    .addNode(NODE_NAMES.plan, createPlanNode(deps))
    .addNode(NODE_NAMES.code, createCodeNode(deps))
    .addNode(NODE_NAMES.verify, createVerifyNode(deps))
    .addNode(NODE_NAMES.diagnose, createDiagnoseNode(deps))
    .addNode(NODE_NAMES.review, createReviewNode(deps))
    .addNode(NODE_NAMES.finalize, createFinalizeNode(deps))

    .addEdge(START, NODE_NAMES.inspect)
    .addEdge(NODE_NAMES.inspect, NODE_NAMES.research)
    .addEdge(NODE_NAMES.research, NODE_NAMES.plan)
    .addEdge(NODE_NAMES.plan, NODE_NAMES.code)
    .addEdge(NODE_NAMES.code, NODE_NAMES.verify)

    .addConditionalEdges(NODE_NAMES.verify, (state) => routers.afterVerify(state), {
      diagnose: NODE_NAMES.diagnose,
      review: NODE_NAMES.review,
      finalize: NODE_NAMES.finalize,
    })

    .addConditionalEdges(NODE_NAMES.diagnose, (state) => routers.afterDiagnose(state), {
      research: NODE_NAMES.research,
      code: NODE_NAMES.code,
      finalize: NODE_NAMES.finalize,
    })

    .addEdge(NODE_NAMES.review, NODE_NAMES.finalize)
    .addEdge(NODE_NAMES.finalize, END);

  return graph.compile();
}

export type CanvilGraph = ReturnType<typeof buildCanvilGraph>;

/** ASCII rendering of the graph, used by `canvil doctor`. */
export function describeGraph(): string {
  return [
    "START",
    "  -> inspect      scan project, rank context files",
    "  -> research     local knowledge first, then web",
    "  -> plan         structured implementation plan",
    "  -> code         structured file operations (approval gated)",
    "  -> verify       run the project's own tests",
    "       |- passed  -> review -> finalize -> END",
    "       |- failed  -> diagnose -> code   (bounded by agent.maxIterations)",
    "       |                |- needs knowledge -> research -> plan -> code",
    "       |- no --test command -> review",
    "       |- budget spent -> finalize",
  ].join("\n");
}
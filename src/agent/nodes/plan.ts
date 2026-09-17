/**
 * `plan` node: turn understanding plus research into an ordered plan.
 *
 * The plan is structured output, not prose, so the coding step can be held to
 * it and the report can show exactly what was promised.
 */

import { planSchema, SCHEMA_NAMES } from "../schemas.js";
import { PLAN_SYSTEM_PROMPT } from "../prompts.js";
import type { AgentDeps } from "./deps.js";
import { promptContextFor } from "./deps.js";
import { renderRepositoryContext } from "../prompts.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";

export function createPlanNode(deps: AgentDeps) {
  return async function plan(state: CanvilStateType): Promise<CanvilStateUpdate> {
    deps.logger.info("Planning implementation");

    const context = promptContextFor(state);
    const user = [
      renderRepositoryContext(context),
      [
        "## Planning instructions",
        "- The plan must be executable within this repository as it exists now.",
        "- Reference only files and commands you have actually seen.",
        state.profile?.commands.test
          ? `- The project's test command is: ${state.profile.commands.test}`
          : "- No test command was detected; state how the change will be verified instead.",
      ].join("\n"),
    ].join("\n\n");

    const plan = await deps.model.structured({
      name: SCHEMA_NAMES.plan,
      schema: planSchema,
      prompt: { system: PLAN_SYSTEM_PROMPT, user },
    });

    deps.journal.record("plan", plan.summary, {
      steps: plan.steps.length,
      filesToCreate: plan.filesToCreate,
      filesToModify: plan.filesToModify,
      risks: plan.risks,
      assumptions: plan.assumptions,
    });

    const trace = logLine(
      `plan: ${plan.steps.length} step(s), ${plan.filesToCreate.length} file(s) to create, ${plan.filesToModify.length} to modify`,
    );
    if (plan.risks.length > 0) trace.push(`risks: ${plan.risks.join("; ")}`);

    return {
      plan,
      status: "coding",
      log: trace,
    };
  };
}
/**
 * `diagnose` node: explain a failed verification before trying again.
 *
 * The failure text is passed through verbatim (tail-biased, because runners print
 * their summary last) so the model reasons about the real error rather than a
 * paraphrase of it. The diagnosis decides whether the next attempt needs more
 * research or just another fix.
 */

import { DIAGNOSIS_SYSTEM_PROMPT, renderRepositoryContext } from "../prompts.js";
import { diagnosisSchema, SCHEMA_NAMES } from "../schemas.js";
import { promptContextFor, type AgentDeps } from "./deps.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";
import { readTextFile } from "../../tools/filesystem/walk.js";
import { truncate } from "../../util/text.js";

export function createDiagnoseNode(deps: AgentDeps) {
  return async function diagnose(state: CanvilStateType): Promise<CanvilStateUpdate> {
    const lastRun = state.testRuns[state.testRuns.length - 1];
    deps.logger.info("Diagnosing failure", {
      command: lastRun?.command,
      exitCode: lastRun?.exitCode,
    });

    // Give the model the suspect files it will need to reason about the failure.
    const suspectSources = await readSuspectFiles(state, deps);

    const user = [
      renderRepositoryContext(promptContextFor(state)),
      `## Failing command\n${lastRun?.command ?? "(unknown)"}`,
      `## Parsed summary\n${lastRun?.summaryText ?? "(no summary parsed)"}`,
      `## Failing tests\n${lastRun && lastRun.failures.length > 0 ? lastRun.failures.map((f) => `- ${f}`).join("\n") : "(none parsed)"}`,
      `## Output (tail)\n\`\`\`\n${truncate(`${lastRun?.stdout ?? ""}\n${lastRun?.stderr ?? ""}`.trim(), 12_000)}\n\`\`\``,
      suspectSources,
      [
        "## Instructions",
        `This is attempt ${state.iteration} of ${deps.toolContext.config.agent.maxIterations}.`,
        "- Decide whether the failure is caused by the change, by the environment, or by pre-existing breakage.",
        "- If the same approach cannot work, say so and propose a different one.",
      ].join("\n"),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const diagnosis = await deps.model.structured({
      name: SCHEMA_NAMES.diagnosis,
      schema: diagnosisSchema,
      prompt: { system: DIAGNOSIS_SYSTEM_PROMPT, user },
    });

    deps.journal.record("error", `Diagnosis: ${diagnosis.rootCause}`, {
      fixStrategy: diagnosis.fixStrategy,
      needsResearch: diagnosis.needsResearch,
      unrecoverable: diagnosis.unrecoverable,
    });

    if (diagnosis.unrecoverable) {
      return {
        diagnosis,
        status: "failed",
        haltReason: `Cannot proceed: ${diagnosis.rootCause}`,
        log: logLine(`diagnosis: unrecoverable — ${diagnosis.rootCause}`),
      };
    }

    const focus = diagnosis.needsResearch ? diagnosis.researchQueries : [];
    return {
      diagnosis,
      researchFocus: focus,
      verificationFeedback: [
        state.verificationFeedback ?? "",
        `## Diagnosis\n${diagnosis.rootCause}\n\nRequired fix: ${diagnosis.fixStrategy}`,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
      status: focus.length > 0 ? "researching" : "coding",
      log: [
        ...logLine(`diagnosis: ${diagnosis.rootCause}`),
        ...(focus.length > 0 ? [`researching ${focus.length} focused query/queries`] : []),
      ],
    };
  };
}

async function readSuspectFiles(state: CanvilStateType, deps: AgentDeps): Promise<string> {
  const candidates = [
    ...state.testRuns.flatMap((run) => run.failures),
    ...(state.lastCodeResponse?.operations ?? []).map((operation) => operation.path),
  ]
    .filter((value) => value.includes(".") && !value.includes(" "))
    .slice(0, 6);

  const sections: string[] = [];
  for (const candidate of new Set(candidates)) {
    try {
      const file = readTextFile(deps.toolContext.repoRoot, candidate, { maxBytes: 20_000 });
      sections.push(`### FILE: ${candidate}\n\`\`\`\n${file.content}\n\`\`\``);
    } catch {
      // A stack frame referencing a file that no longer exists is not fatal.
    }
  }
  return sections.length > 0 ? `## Suspect files\n${sections.join("\n\n")}` : "";
}
/**
 * `inspect` node: understand the repository before anything else happens.
 *
 * This runs no model calls. Deterministic inspection first is the cheapest way
 * to give the model real ground truth, and it means a run is useful even when
 * the model is unavailable (`canvil scan`).
 */

import { selectContextFiles, readContextPack } from "../../project/analyzer.js";
import { scanProject } from "../../project/scanner.js";
import { readGitState } from "../../tools/git/index.js";
import type { AgentDeps } from "./deps.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";

const CONTEXT_CHAR_BUDGET = 120_000;

export function createInspectNode(deps: AgentDeps) {
  return async function inspect(state: CanvilStateType): Promise<CanvilStateUpdate> {
    deps.logger.info("Inspecting repository", { root: deps.toolContext.repoRoot });

    const profile = scanProject(deps.toolContext.repoRoot, {
      documentation: deps.documentation,
      sourcesRegistry: deps.sourcesRegistry,
    });

    const contextFiles = selectContextFiles({
      root: deps.toolContext.repoRoot,
      task: state.task,
      profile,
      maxFiles: deps.toolContext.config.agent.maxContextFiles,
    });

    const contextPack = readContextPack(contextFiles, {
      root: deps.toolContext.repoRoot,
      totalBudget: CONTEXT_CHAR_BUDGET,
    });

    const git = await readGitState({ repoRoot: deps.toolContext.repoRoot });
    const trace = [
      `detected ${profile.primaryLanguage}, stack: ${profile.technologyKeys.slice(0, 8).join(", ") || "unknown"}`,
      `test command: ${profile.commands.test ?? "not detected"}`,
      `selected ${contextPack.files.length} context file(s), ${contextPack.omitted.length} omitted for budget`,
      git.isRepository
        ? `git: on ${git.branch ?? "(detached)"} with ${git.changes.length} uncommitted change(s)`
        : "git: not a repository",
    ];

    deps.journal.record("inspect", "Repository inspected", {
      profile: {
        primaryLanguage: profile.primaryLanguage,
        framework: profile.frameworks,
        commands: profile.commands,
      },
      contextFiles: contextPack.files.map((file) => file.path),
      warnings: profile.warnings,
    });

    if (profile.warnings.length > 0) {
      deps.logger.warn("Scanner warnings", { warnings: profile.warnings });
    }
    if (contextFiles.length === 0) {
      deps.logger.warn("No relevant files matched the task; the model will see the profile only");
    }

    return {
      profile,
      contextFiles,
      contextPack,
      status: "researching",
      log: [...logLine("inspect complete"), ...trace],
    };
  };
}
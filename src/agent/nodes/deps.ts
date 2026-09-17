/**
 * Shared node dependencies.
 *
 * Nodes are built as closures over an explicit dependency bag rather than
 * reaching for globals. That is what makes the graph testable: swap the model or
 * the executor and the same node functions run against a temp repository.
 */

import type { DocumentationEntry, SourcesRegistry } from "../../config/registries.js";
import type { KnowledgeBase } from "../../knowledge/rag/knowledge-base.js";
import type { RunJournal } from "../../memory/journal.js";
import type { ToolContext, ToolRegistry } from "../../tools/types.js";
import type { Logger } from "../../util/logger.js";
import type { AgentModel } from "../llm.js";
import type { ApprovalHandler, CanvilStateType } from "../state.js";
import type { PromptContext } from "../prompts.js";

export interface AgentDeps {
  model: AgentModel;
  tools: ToolRegistry;
  /** Base tool context; nodes derive per-phase contexts from it. */
  toolContext: ToolContext;
  knowledgeBase: KnowledgeBase;
  sourcesRegistry: SourcesRegistry;
  documentation: Map<string, DocumentationEntry>;
  journal: RunJournal;
  approval: ApprovalHandler;
  logger: Logger;
  /** Maximum web searches across the whole run. */
  maxResearchQueries: number;
  /** True when writes must never be applied (plan-only execution). */
  readOnly: boolean;
}

/** Build the prompt-facing view of the state. */
export function promptContextFor(state: CanvilStateType): PromptContext {
  return {
    task: state.task,
    profile: state.profile,
    contextPack: state.contextPack,
    research: state.research,
    plan: state.plan,
    diagnosis: state.diagnosis,
  };
}

/** Tool context with the project profile attached once inspection has run. */
export function toolContextFor(deps: AgentDeps, state: CanvilStateType): ToolContext {
  const base = deps.toolContext;
  return {
    ...base,
    logger: base.logger.child("tool"),
    ...(state.profile ? { profile: state.profile } : {}),
  };
}

/** Throw a clear error when a tool produced an unexpected shape. */
export function expectResult<T>(value: unknown, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} returned no result`);
  }
  return value as T;
}
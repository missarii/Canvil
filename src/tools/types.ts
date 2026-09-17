/**
 * Tool contracts.
 *
 * Every capability Canvil has is a `ToolDefinition`: a name, a description, a
 * zod schema and an effect class. The effect class is what the approval layer
 * and the sandbox policy key off, and it is also what a future MCP server would
 * export, so nothing here is allowed to depend on LangChain.
 */

import { z } from "zod";
import type { CanvilConfig, CanvilEnv } from "../config/types.js";
import type { ProjectProfile } from "../project/types.js";
import type { Logger } from "../util/logger.js";

export type ToolEffect = "read" | "write" | "execute" | "network";

/** Injected into every tool call. Tests swap the network and sandbox here. */
export interface ToolContext {
  /** Absolute path of the repository Canvil is working on. */
  repoRoot: string;
  config: CanvilConfig;
  env: CanvilEnv;
  logger: Logger;
  /** Overridable fetch, so tests never touch the network. */
  fetchImpl: typeof fetch;
  /** Executes commands; present unless the caller disabled execution. */
  executor: CommandExecutor;
  /** Project profile from the scanner; absent before the inspect step. */
  profile?: ProjectProfile;
}

export interface CommandRequest {
  command: string;
  /** Working directory, relative to the repo root. Defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  command: string;
  /** "docker" or "local": where it actually ran. */
  isolation: "docker" | "local" | "none";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** True when the output was cut at the configured limit. */
  truncated: boolean;
}

export interface CommandExecutor {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  effect: ToolEffect;
  execute: (input: never, context: ToolContext) => Promise<unknown>;
}

/** Declare a tool while keeping the handler's input type inferred. */
export function defineTool<TSchema extends z.ZodType, TResult>(definition: {
  name: string;
  description: string;
  schema: TSchema;
  effect: ToolEffect;
  execute: (input: z.infer<TSchema>, context: ToolContext) => Promise<TResult>;
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    effect: definition.effect,
    execute: definition.execute as unknown as ToolDefinition["execute"],
  };
}

/** Parse and validate input, converting zod failures into readable messages. */
export function parseToolInput<T>(tool: ToolDefinition, input: unknown): T {
  const result = tool.schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid input for tool "${tool.name}": ${issues}`);
  }
  return result.data as T;
}

/** A plain, serializable view of a tool — used by `canvil tools` and reports. */
export interface ToolSummary {
  name: string;
  description: string;
  effect: ToolEffect;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Look up a tool or fail loudly; used by the agent wiring. */
  require(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  summaries(): ToolSummary[] {
    return this.list().map(({ name, description, effect }) => ({ name, description, effect }));
  }

  /** Run a tool with validated input and effect-aware logging. */
  async invoke(name: string, input: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.require(name);
    const parsed = parseToolInput(tool, input);
    context.logger.debug(`tool:${name}`, { effect: tool.effect });
    return tool.execute(parsed as never, context);
  }
}

/** An executor used when command execution is disabled (e.g. `--dry-run`). */
export const noopExecutor: CommandExecutor = {
  async run(request: CommandRequest): Promise<CommandResult> {
    return {
      command: request.command,
      isolation: "none",
      exitCode: null,
      stdout: "",
      stderr: "Command execution is disabled for this run.",
      timedOut: false,
      durationMs: 0,
      truncated: false,
    };
  },
};
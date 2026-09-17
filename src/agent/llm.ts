/**
 * Model abstraction.
 *
 * Nodes depend on `AgentModel`, never on a provider class. That keeps the graph
 * runnable with a scripted fake (tests, `--dry-run`, CI) and means adding a
 * provider is a factory change rather than a graph rewrite.
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";
import type { CanvilConfig, CanvilEnv } from "../config/types.js";
import { ConfigError, ModelOutputError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export interface ModelPrompt {
  system: string;
  user: string;
}

export interface StructuredRequest<TSchema extends z.ZodType> {
  /** Contract name; also used to route fake responses. */
  name: string;
  schema: TSchema;
  prompt: ModelPrompt;
  /** Retry the model once on a validation failure before giving up. */
  retries?: number;
}

export interface AgentModel {
  readonly name: string;
  /** Provider label for the report, e.g. "openai:gpt-4.1-mini". */
  readonly label: string;
  structured<TSchema extends z.ZodType>(
    request: StructuredRequest<TSchema>,
  ): Promise<z.infer<TSchema>>;
  /** Plain completion, used for narrative sections such as the run summary. */
  text(prompt: ModelPrompt): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible provider                                                 */
/* -------------------------------------------------------------------------- */

export class OpenAiAgentModel implements AgentModel {
  readonly name: string;
  readonly label: string;
  private readonly model: ChatOpenAI;

  constructor(settings: CanvilConfig["model"], env: CanvilEnv, private readonly logger: Logger) {
    this.name = settings.name;
    this.label = `openai:${settings.name}`;
    this.model = new ChatOpenAI({
      model: settings.name,
      temperature: settings.temperature,
      maxTokens: settings.maxOutputTokens,
      apiKey: env.openaiApiKey,
      ...(settings.baseUrl ? { configuration: { baseURL: settings.baseUrl } } : {}),
    });
  }

  async structured<TSchema extends z.ZodType>(
    request: StructuredRequest<TSchema>,
  ): Promise<z.infer<TSchema>> {
    const retries = request.retries ?? 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const repairNote =
        attempt === 0
          ? ""
          : `\n\nCONTRACT VIOLATION on the previous attempt (${String(lastError)}). ` +
            "Return only data that satisfies the schema exactly.";
      try {
        const runnable = this.model.withStructuredOutput(request.schema, { name: request.name });
        const result = await runnable.invoke([
          new SystemMessage(request.prompt.system),
          new HumanMessage(request.prompt.user + repairNote),
        ]);
        return result as z.infer<TSchema>;
      } catch (error) {
        lastError = error;
        this.logger.warn("Structured output attempt failed", {
          schema: request.name,
          attempt: attempt + 1,
          error: (error as Error).message,
        });
      }
    }

    throw new ModelOutputError(
      `Model did not produce valid "${request.name}" output after ${retries + 1} attempt(s): ${String(lastError)}`,
      { cause: lastError },
    );
  }

  async text(prompt: ModelPrompt): Promise<string> {
    const response = await this.model.invoke([
      new SystemMessage(prompt.system),
      new HumanMessage(prompt.user),
    ]);
    const content = response.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "string" ? part : "text" in part ? part.text : ""))
        .join("");
    }
    return "";
  }
}

/* -------------------------------------------------------------------------- */
/* Fake provider                                                              */
/* -------------------------------------------------------------------------- */

export type FakeResponse = unknown | ((prompt: ModelPrompt) => unknown);

/**
 * Scripted model for tests and dry runs.
 *
 * `structured()` pulls the next queued response for a schema name; when the
 * queue is empty it throws, so a test that forgot to script a step fails loudly
 * instead of silently producing an empty plan.
 */
export class FakeAgentModel implements AgentModel {
  readonly name = "fake";
  readonly label = "fake:scripted";
  private readonly queues = new Map<string, FakeResponse[]>();
  private readonly texts: string[] = [];
  /** Every prompt this model received, for assertions about what was sent. */
  readonly calls: Array<{ name: string; prompt: ModelPrompt }> = [];

  constructor(
    script: Record<string, FakeResponse | FakeResponse[]> = {},
    private readonly logger?: Logger,
  ) {
    for (const [name, value] of Object.entries(script)) {
      this.queues.set(name, Array.isArray(value) ? [...value] : [value]);
    }
  }

  /** Add more scripted responses mid-run (used by fix-loop tests). */
  push(name: string, ...responses: FakeResponse[]): void {
    const queue = this.queues.get(name) ?? [];
    queue.push(...responses);
    this.queues.set(name, queue);
  }

  async structured<TSchema extends z.ZodType>(
    request: StructuredRequest<TSchema>,
  ): Promise<z.infer<TSchema>> {
    this.calls.push({ name: request.name, prompt: request.prompt });
    const queue = this.queues.get(request.name);
    const next = queue?.shift();
    if (next === undefined) {
      throw new ModelOutputError(
        `FakeAgentModel has no scripted response for "${request.name}". ` +
          `Scripted names: ${[...this.queues.keys()].join(", ") || "none"}`,
      );
    }
    const value =
      typeof next === "function" ? (next as (p: ModelPrompt) => unknown)(request.prompt) : next;
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) {
      throw new ModelOutputError(
        `FakeAgentModel response for "${request.name}" violates its schema: ${parsed.error.message}`,
      );
    }
    this.logger?.debug("fake model response used", { schema: request.name });
    return parsed.data as z.infer<TSchema>;
  }

  async text(prompt: ModelPrompt): Promise<string> {
    this.calls.push({ name: "text", prompt });
    return this.texts.shift() ?? "Dry run: no narrative summary generated.";
  }

  /** Queue narrative output for `text()` calls. */
  pushText(...values: string[]): void {
    this.texts.push(...values);
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateModelOptions {
  config: CanvilConfig;
  env: CanvilEnv;
  logger: Logger;
  /** Force the fake model (tests, dry runs). */
  forceFake?: boolean;
  /** Script used when the fake model is selected. */
  fakeScript?: Record<string, FakeResponse | FakeResponse[]>;
}

export function createAgentModel(options: CreateModelOptions): AgentModel {
  const { config, env, logger, forceFake, fakeScript } = options;
  if (forceFake || config.model.provider === "fake") {
    return new FakeAgentModel(fakeScript ?? {}, logger);
  }
  if (!env.openaiApiKey && !config.model.baseUrl) {
    throw new ConfigError(
      "No model credentials found. Set OPENAI_API_KEY, point CANVIL_MODEL_BASE_URL at a local OpenAI-compatible server (for example http://localhost:11434/v1 for Ollama), or run with --dry-run to use the scripted model.",
    );
  }
  return new OpenAiAgentModel(config.model, env, logger);
}
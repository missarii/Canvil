/**
 * Configuration loading and merging.
 *
 * Nothing here throws on a *missing* file (defaults are always usable), but a
 * present-yet-malformed file is a hard error: silently ignoring a typo in a
 * security allowlist would be worse than failing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type CanvilConfig, type ModelProvider, type SandboxMode } from "./types.js";
import { parseBooleanEnv, parseFloatEnv, parseIntegerEnv } from "./env.js";
import { ConfigError } from "../util/errors.js";

/** Directory holding `config/*.json` shipped with Canvil. */
export function findCanvilHome(from: string = import.meta.url): string {
  const override = process.env.CANVIL_HOME?.trim();
  if (override && override.length > 0) return path.resolve(override);

  // Walk up from the compiled/executed module until we find our config folder.
  // Works both from `src/` (tsx) and `dist/` (compiled).
  let current = path.dirname(fileURLToPath(from));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, "config", "documentation.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export function canvilConfigPath(home: string = findCanvilHome()): string {
  return path.join(home, "config", "canvil.config.json");
}

export function documentationRegistryPath(home: string = findCanvilHome()): string {
  return path.join(home, "config", "documentation.json");
}

export function sourcesRegistryPath(home: string = findCanvilHome()): string {
  return path.join(home, "config", "sources.json");
}

export function knowledgeBasePath(home: string = findCanvilHome()): string {
  return path.join(home, "knowledge-base");
}

/** Recursive merge for plain objects; arrays and scalars are replaced. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override as T;
  if (typeof base === "object" && typeof override === "object") {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      if (key.startsWith("$")) continue; // `$comment` and friends are documentation only.
      const existing = (base as Record<string, unknown>)[key];
      result[key] =
        existing !== undefined && existing !== null && typeof existing === "object"
          ? deepMerge(existing, value)
          : value;
    }
    return result as T;
  }
  return override as T;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read configuration file ${filePath}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${filePath}: ${(error as Error).message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`Configuration file ${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Validate the parts of the config where a wrong value is a real hazard. */
export function validateConfig(config: CanvilConfig): void {
  const modes: SandboxMode[] = ["docker", "local"];
  if (!modes.includes(config.sandbox.mode)) {
    throw new ConfigError(`sandbox.mode must be one of ${modes.join(", ")}, received "${config.sandbox.mode}"`);
  }
  if (config.sandbox.timeoutMs < 1_000) {
    throw new ConfigError("sandbox.timeoutMs must be at least 1000");
  }
  if (config.agent.maxIterations < 1) {
    throw new ConfigError("agent.maxIterations must be at least 1");
  }
  for (const [label, patterns] of [
    ["commands.allow", config.commands.allow],
    ["commands.block", config.commands.block],
  ] as const) {
    for (const pattern of patterns) {
      try {
        new RegExp(pattern);
      } catch (error) {
        throw new ConfigError(`${label} contains an invalid regular expression "${pattern}"`, {
          cause: error,
        });
      }
    }
  }
  const providers: ModelProvider[] = ["openai", "fake"];
  if (!providers.includes(config.model.provider)) {
    throw new ConfigError(`model.provider must be one of ${providers.join(", ")}`);
  }
}

function applyEnvOverrides(config: CanvilConfig, env: NodeJS.ProcessEnv): CanvilConfig {
  let next: CanvilConfig = config;

  const modelProvider = env.CANVIL_MODEL_PROVIDER?.trim() as ModelProvider | undefined;
  const modelName = env.CANVIL_MODEL?.trim();
  const modelBaseUrl = env.CANVIL_MODEL_BASE_URL?.trim();
  const temperature = parseFloatEnv("CANVIL_TEMPERATURE", env.CANVIL_TEMPERATURE);
  const maxOutputTokens = parseIntegerEnv("CANVIL_MAX_OUTPUT_TOKENS", env.CANVIL_MAX_OUTPUT_TOKENS);

  const modelOverrides: Partial<CanvilConfig["model"]> = {};
  if (modelProvider) modelOverrides.provider = modelProvider;
  if (modelName) modelOverrides.name = modelName;
  if (modelBaseUrl !== undefined) modelOverrides.baseUrl = modelBaseUrl;
  if (temperature !== undefined) modelOverrides.temperature = temperature;
  if (maxOutputTokens !== undefined) modelOverrides.maxOutputTokens = maxOutputTokens;
  if (Object.keys(modelOverrides).length > 0) {
    next = { ...next, model: { ...next.model, ...modelOverrides } };
  }

  const sandboxMode = env.CANVIL_SANDBOX?.trim() as SandboxMode | undefined;
  const sandboxImage = env.CANVIL_SANDBOX_IMAGE?.trim();
  const network = parseBooleanEnv("CANVIL_SANDBOX_NETWORK", env.CANVIL_SANDBOX_NETWORK);
  const timeoutMs = parseIntegerEnv("CANVIL_COMMAND_TIMEOUT_MS", env.CANVIL_COMMAND_TIMEOUT_MS);

  const sandboxOverrides: Partial<CanvilConfig["sandbox"]> = {};
  if (sandboxMode) sandboxOverrides.mode = sandboxMode;
  if (sandboxImage) sandboxOverrides.image = sandboxImage;
  if (network !== undefined) sandboxOverrides.network = network;
  if (timeoutMs !== undefined) sandboxOverrides.timeoutMs = timeoutMs;
  if (Object.keys(sandboxOverrides).length > 0) {
    next = { ...next, sandbox: { ...next.sandbox, ...sandboxOverrides } };
  }

  const maxIterations = parseIntegerEnv("CANVIL_MAX_ITERATIONS", env.CANVIL_MAX_ITERATIONS);
  const autoApprove = parseBooleanEnv("CANVIL_AUTO_APPROVE", env.CANVIL_AUTO_APPROVE);
  const agentOverrides: Partial<CanvilConfig["agent"]> = {};
  if (maxIterations !== undefined) agentOverrides.maxIterations = maxIterations;
  if (autoApprove !== undefined) agentOverrides.requireApprovalForWrite = !autoApprove;
  if (Object.keys(agentOverrides).length > 0) {
    next = { ...next, agent: { ...next.agent, ...agentOverrides } };
  }

  return next;
}

export interface LoadConfigOptions {
  /** Canvil installation root holding `config/`. Defaults to auto-detection. */
  home?: string;
  /** Target repository; `<repo>/.canvil/config.json` overrides the home config. */
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  config: CanvilConfig;
  /** Files that actually contributed to the result, in merge order. */
  sources: string[];
  home: string;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const home = options.home ?? findCanvilHome();
  const env = options.env ?? process.env;
  const sources: string[] = [];
  let config = DEFAULT_CONFIG;

  const homeConfigPath = canvilConfigPath(home);
  if (fs.existsSync(homeConfigPath)) {
    config = deepMerge(config, readJsonObject(homeConfigPath));
    sources.push(homeConfigPath);
  }

  if (options.repoRoot) {
    const repoConfigPath = path.join(options.repoRoot, ".canvil", "config.json");
    if (fs.existsSync(repoConfigPath)) {
      config = deepMerge(config, readJsonObject(repoConfigPath));
      sources.push(repoConfigPath);
    }
  }

  config = applyEnvOverrides(config, env);
  validateConfig(config);
  return { config, sources, home };
}

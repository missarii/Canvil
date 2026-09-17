/**
 * Configuration shape for Canvil.
 *
 * Precedence (lowest to highest):
 *   built-in defaults -> <canvil-home>/config/canvil.config.json
 *   -> <target-repo>/.canvil/config.json -> environment variables
 */

export type SandboxMode = "docker" | "local";
export type ModelProvider = "openai" | "fake";

export interface ModelSettings {
  provider: ModelProvider;
  name: string;
  /** OpenAI-compatible base URL. Empty string means the provider default. */
  baseUrl: string;
  temperature: number;
  maxOutputTokens: number;
}

export interface SandboxSettings {
  mode: SandboxMode;
  image: string;
  /** Allow outbound network from inside the sandbox. Off by default. */
  network: boolean;
  memory: string;
  cpus: string;
  timeoutMs: number;
  pidsLimit: number;
  user: string;
  readOnlyRepo: boolean;
  extraMounts: string[];
}

export interface CommandPolicySettings {
  /** Patterns a command must match to be allowed. Empty list = nothing runs. */
  allow: string[];
  /** Patterns that always deny, evaluated before `allow`. */
  block: string[];
}

export interface FilesystemPolicySettings {
  /** Globs the agent may write. Everything is writable by default. */
  writableGlobs: string[];
  /** Globs that may never be written, even if `writableGlobs` matches. */
  protectedPaths: string[];
  maxFileSizeBytes: number;
  maxFilesWrittenWithoutApproval: number;
}

export interface AgentSettings {
  /** Maximum code -> test -> fix cycles before Canvil reports failure. */
  maxIterations: number;
  maxResearchQueries: number;
  maxContextFiles: number;
  requireApprovalForWrite: boolean;
  requireApprovalForCommand: boolean;
  recursionLimit: number;
}

export interface LimitSettings {
  maxFetchBytes: number;
  maxWebResults: number;
  requestTimeoutMs: number;
  userAgent: string;
}

export interface CanvilConfig {
  model: ModelSettings;
  sandbox: SandboxSettings;
  commands: CommandPolicySettings;
  filesystem: FilesystemPolicySettings;
  agent: AgentSettings;
  limits: LimitSettings;
}

/** Resolved secrets and endpoints. Never serialized into prompts or journals. */
export interface CanvilEnv {
  openaiApiKey?: string;
  tavilyApiKey?: string;
  braveApiKey?: string;
  searxngUrl?: string;
  githubToken?: string;
}

export const DEFAULT_CONFIG: CanvilConfig = {
  model: {
    provider: "openai",
    name: "gpt-4.1-mini",
    baseUrl: "",
    temperature: 0,
    maxOutputTokens: 4096,
  },
  sandbox: {
    mode: "docker",
    image: "node:22-bookworm-slim",
    network: false,
    memory: "2g",
    cpus: "2",
    timeoutMs: 300_000,
    pidsLimit: 512,
    user: "node",
    readOnlyRepo: false,
    extraMounts: [],
  },
  commands: {
    allow: [],
    block: [],
  },
  filesystem: {
    writableGlobs: ["**"],
    protectedPaths: [".git/**", ".env", ".env.*", "**/*.pem", "**/*.key"],
    maxFileSizeBytes: 400_000,
    maxFilesWrittenWithoutApproval: 25,
  },
  agent: {
    maxIterations: 8,
    maxResearchQueries: 6,
    maxContextFiles: 24,
    requireApprovalForWrite: true,
    requireApprovalForCommand: false,
    recursionLimit: 60,
  },
  limits: {
    maxFetchBytes: 1_500_000,
    maxWebResults: 8,
    requestTimeoutMs: 20_000,
    userAgent: "Canvil/0.1",
  },
};
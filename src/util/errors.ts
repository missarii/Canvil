/**
 * Error hierarchy. Every failure Canvil can meaningfully react to gets its own
 * class so the agent can route on it instead of string-matching messages.
 */

export class CanvilError extends Error {
  /** Stable, machine-readable code (used in run journals and CLI output). */
  readonly code: string;

  constructor(message: string, code = "CANVIL_ERROR", options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Bad or missing configuration (config files, env vars, unusable model). */
export class ConfigError extends CanvilError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG_ERROR", options);
  }
}

/**
 * A path resolution or write was refused by the workspace jail. This is a
 * security boundary, not a bug: callers should surface it, never retry blindly.
 */
export class PathSecurityError extends CanvilError {
  constructor(message: string, filePath: string, options?: { cause?: unknown }) {
    super(message, "PATH_SECURITY", options);
    this.filePath = filePath;
  }

  readonly filePath: string;
}

/** A shell command was rejected by the command policy before execution. */
export class CommandPolicyError extends CanvilError {
  constructor(message: string, command: string, options?: { cause?: unknown }) {
    super(message, "COMMAND_POLICY", options);
    this.command = command;
  }

  readonly command: string;
}

/** A command ran but failed (non-zero exit, timeout, sandbox failure). */
export class CommandFailedError extends CanvilError {
  constructor(
    message: string,
    readonly result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean },
    options?: { cause?: unknown },
  ) {
    super(message, "COMMAND_FAILED", options);
  }
}

/** A tool could not complete because a required credential is absent. */
export class MissingCredentialError extends CanvilError {
  constructor(message: string, readonly envVar: string) {
    super(message, "MISSING_CREDENTIAL");
  }
}

/** An external service returned an error or unusable payload. */
export class ExternalServiceError extends CanvilError {
  constructor(message: string, readonly service: string, options?: { cause?: unknown }) {
    super(message, `EXTERNAL_SERVICE:${service}`, options);
  }
}

/** The model returned something that violates the expected contract. */
export class ModelOutputError extends CanvilError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "MODEL_OUTPUT", options);
  }
}

/** Narrow an unknown catch value into an Error without losing the original. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}
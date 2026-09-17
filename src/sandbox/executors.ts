/**
 * Command executors.
 *
 * `DockerSandbox` is the default and the one Canvil assumes when it reasons
 * about safety: the repository is mounted, the network is off, and the process
 * runs as an unprivileged user with CPU/memory/PID caps. `LocalSandbox` exists
 * for environments without a Docker daemon (CI images, restricted hosts) and is
 * explicitly weaker — the command allowlist is then the only real control.
 */

import path from "node:path";
import type { CanvilConfig } from "../config/types.js";
import type { CommandExecutor, CommandRequest, CommandResult } from "../tools/types.js";
import { CommandFailedError, ConfigError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import { resolveInside } from "../util/paths.js";
import { truncateMiddle } from "../util/text.js";
import { assertCommandAllowed, sanitizedEnvironment } from "./policy.js";
import { commandExists, runProcess, type ProcessOutcome } from "./process.js";

const CONTAINER_WORKSPACE = "/workspace";
const DOCKER_OVERHEAD_MS = 15_000;
const MAX_STDERR_BYTES = 40_000;

abstract class BaseExecutor implements CommandExecutor {
  protected readonly logger: Logger;

  constructor(
    protected readonly config: CanvilConfig,
    logger: Logger,
  ) {
    this.logger = logger.child("sandbox");
  }

  abstract run(request: CommandRequest): Promise<CommandResult>;

  protected toResult(
    request: CommandRequest,
    isolation: CommandResult["isolation"],
    outcome: ProcessOutcome,
  ): CommandResult {
    const timeoutMs = request.timeoutMs ?? this.config.sandbox.timeoutMs;
    const result: CommandResult = {
      command: request.command,
      isolation,
      exitCode: outcome.exitCode,
      stdout: truncateMiddle(outcome.stdout, this.config.limits.maxFetchBytes),
      stderr: truncateMiddle(outcome.stderr, MAX_STDERR_BYTES),
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated,
    };

    if (outcome.spawnError) {
      result.stderr = `${result.stderr}\nFailed to start process: ${outcome.spawnError}`.trim();
      result.exitCode = null;
      return result;
    }
    if (outcome.timedOut) {
      this.logger.warn("Command timed out", { command: request.command, timeoutMs });
    }
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Docker                                                                     */
/* -------------------------------------------------------------------------- */

export class DockerSandbox extends BaseExecutor {
  private static counter = 0;
  private dockerAvailable: Promise<boolean> | undefined;

  constructor(
    config: CanvilConfig,
    logger: Logger,
    private readonly repoRoot: string,
  ) {
    super(config, logger);
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const decision = assertCommandAllowed(request.command, this.config);
    this.logger.debug("Command allowed", {
      command: request.command,
      pattern: decision.matchedPattern,
    });

    if (!(await this.hasDocker())) {
      throw new ConfigError(
        'sandbox.mode is "docker" but no docker binary is available. Install Docker, or set CANVIL_SANDBOX=local to run commands on the host (weaker isolation).',
      );
    }

    // Fail early (and with a clear message) when the requested cwd escapes the
    // repository, even though Docker resolves the path inside the container.
    if (request.cwd && request.cwd.length > 0) {
      resolveInside(this.repoRoot, request.cwd, { allowRoot: true });
    }

    const timeoutMs = request.timeoutMs ?? this.config.sandbox.timeoutMs;
    const containerName = `canvil-${process.pid}-${(DockerSandbox.counter += 1)}`;
    const args = this.buildArgs(request, containerName);

    const cancelReaper = this.startContainerReaper(containerName, timeoutMs);
    try {
      const outcome = await runProcess({
        file: "docker",
        args,
        cwd: path.resolve(this.repoRoot),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: timeoutMs + DOCKER_OVERHEAD_MS,
        maxOutputBytes: this.config.limits.maxFetchBytes,
      });
      return this.toResult(request, "docker", outcome);
    } finally {
      cancelReaper();
      // The normal path exits through --rm; this covers the kill path only.
      void runProcess({
        file: "docker",
        args: ["rm", "-f", containerName],
        cwd: path.resolve(this.repoRoot),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        maxOutputBytes: 2_000,
      });
    }
  }

  private buildArgs(request: CommandRequest, containerName: string): string[] {
    const sandbox = this.config.sandbox;
    const repoRoot = path.resolve(this.repoRoot);
    const mount = sandbox.readOnlyRepo
      ? `${repoRoot}:${CONTAINER_WORKSPACE}:ro`
      : `${repoRoot}:${CONTAINER_WORKSPACE}`;

    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--network",
      sandbox.network ? "bridge" : "none",
      "--memory",
      sandbox.memory,
      "--cpus",
      sandbox.cpus,
      "--pids-limit",
      String(sandbox.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "-v",
      mount,
      "-w",
      this.containerWorkdir(request.cwd),
    ];

    if (sandbox.user.trim().length > 0) {
      args.push("--user", sandbox.user.trim());
    }
    for (const extraMount of sandbox.extraMounts) {
      args.push("-v", extraMount);
    }

    for (const [key, value] of Object.entries(this.containerEnv(request.env))) {
      args.push("--env", `${key}=${value}`);
    }

    args.push(sandbox.image, "sh", "-lc", request.command);
    return args;
  }

  /** Translate a repo-relative cwd into the container's working directory. */
  private containerWorkdir(cwd: string | undefined): string {
    if (!cwd || cwd.trim().length === 0) return CONTAINER_WORKSPACE;
    const normalized = cwd
      .split(/[\\/]+/)
      .filter((part) => part.length > 0 && part !== ".")
      .join("/");
    return normalized.length === 0 ? CONTAINER_WORKSPACE : `${CONTAINER_WORKSPACE}/${normalized}`;
  }

  /**
   * Deliberately minimal: the container's own PATH/HOME are correct for the
   * image while the host's would be wrong, and secrets never cross the boundary.
   */
  private containerEnv(extra: Record<string, string> | undefined): Record<string, string> {
    const user = this.config.sandbox.user.trim();
    const env: Record<string, string> = {
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_AUDIT: "false",
      ...(user === "node" ? { HOME: "/home/node" } : {}),
      ...(user === "root" ? { HOME: "/root" } : {}),
    };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (/(_TOKEN|_SECRET|_PASSWORD|_API_KEY|^AWS_)/i.test(key)) continue;
      env[key] = value;
    }
    return env;
  }

  /** Kill the container if the CLI is still alive when the deadline passes. */
  private startContainerReaper(containerName: string, timeoutMs: number): () => void {
    const timer = setTimeout(() => {
      this.logger.warn("Killing sandbox container after timeout", { containerName });
      void runProcess({
        file: "docker",
        args: ["kill", containerName],
        cwd: path.resolve(this.repoRoot),
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        maxOutputBytes: 2_000,
      });
    }, timeoutMs + DOCKER_OVERHEAD_MS - 1_000);
    timer.unref();
    return () => clearTimeout(timer);
  }

  private hasDocker(): Promise<boolean> {
    this.dockerAvailable ??= commandExists("docker");
    return this.dockerAvailable;
  }
}

/* -------------------------------------------------------------------------- */
/* Local                                                                      */
/* -------------------------------------------------------------------------- */

export class LocalSandbox extends BaseExecutor {
  constructor(
    config: CanvilConfig,
    logger: Logger,
    private readonly repoRoot: string,
  ) {
    super(config, logger);
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const decision = assertCommandAllowed(request.command, this.config);
    this.logger.debug("Command allowed", {
      command: request.command,
      pattern: decision.matchedPattern,
    });

    const timeoutMs = request.timeoutMs ?? this.config.sandbox.timeoutMs;
    const cwd = resolveInside(
      this.repoRoot,
      request.cwd && request.cwd.length > 0 ? request.cwd : ".",
      { allowRoot: true },
    );

    const isWindows = process.platform === "win32";
    const outcome = await runProcess({
      file: isWindows ? "cmd" : "sh",
      args: isWindows ? ["/d", "/s", "/c", request.command] : ["-lc", request.command],
      cwd,
      env: sanitizedEnvironment(request.env),
      timeoutMs,
      maxOutputBytes: this.config.limits.maxFetchBytes,
    });

    return this.toResult(request, "local", outcome);
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export interface ExecutorOptions {
  repoRoot: string;
  config: CanvilConfig;
  logger: Logger;
  /** Force local execution regardless of configuration (used by tests). */
  forceLocal?: boolean;
}

export function createCommandExecutor(options: ExecutorOptions): CommandExecutor {
  const { repoRoot, config, logger, forceLocal } = options;
  if (forceLocal || config.sandbox.mode === "local") {
    return new LocalSandbox(config, logger, repoRoot);
  }
  return new DockerSandbox(config, logger, repoRoot);
}

/** Wrap an executor so a failed command throws instead of returning a result. */
export async function runOrThrow(
  executor: CommandExecutor,
  request: CommandRequest,
  label = "Command",
): Promise<CommandResult> {
  const result = await executor.run(request);
  if (result.exitCode !== 0) {
    throw new CommandFailedError(`${label} failed (exit ${result.exitCode ?? "null"})`, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });
  }
  return result;
}
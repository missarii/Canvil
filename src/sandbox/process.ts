/**
 * Process execution primitives shared by the local and Docker executors.
 */

import { spawn } from "node:child_process";
import { stripAnsi } from "../util/text.js";

export interface ProcessRequest {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Cap on captured stdout/stderr, per stream. */
  maxOutputBytes?: number;
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  /** Set when the process could not even be spawned (e.g. docker missing). */
  spawnError?: string;
}

const DEFAULT_MAX_OUTPUT = 200_000;

/**
 * Run a process with a hard timeout and bounded output.
 *
 * On timeout the whole process group is killed (`SIGKILL` to `-pid`), otherwise
 * a shell that spawned children would leave orphans behind after the run.
 */
export async function runProcess(request: ProcessRequest): Promise<ProcessOutcome> {
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const startedAt = Date.now();

  return new Promise<ProcessOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(request.file, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so we can kill the whole tree
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // Give the kill a moment, then resolve regardless.
      setTimeout(() => finish(null), 250).unref();
    }, request.timeoutMs);

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - current.length;
      if (chunk.length > remaining) {
        truncated = true;
        return current + chunk.subarray(0, remaining).toString("utf8");
      }
      return current + chunk.toString("utf8");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: stripAnsi(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
        spawnError: error.message,
      });
    });

    child.on("close", (code) => finish(code));
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** True when an executable is on PATH (used to detect docker availability). */
export async function commandExists(file: string): Promise<boolean> {
  const probe = await runProcess({
    file: process.platform === "win32" ? "where" : "which",
    args: [file],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 5_000,
    maxOutputBytes: 2_000,
  });
  return probe.exitCode === 0 && probe.spawnError === undefined;
}
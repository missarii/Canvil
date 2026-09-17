/**
 * Run journal (long-term memory).
 *
 * Every run appends a structured, append-only record to `<repo>/.canvil/`. Two
 * reasons: a human can audit exactly what an autonomous agent did after the
 * fact, and a later run can read the previous one's failures instead of
 * rediscovering them. Secrets never reach a journal line.
 */

import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../util/logger.js";
import { stableStringify, truncate } from "../util/text.js";

export type JournalEventType =
  | "run-start"
  | "inspect"
  | "research"
  | "research-plan"
  | "research-findings"
  | "plan"
  | "edit"
  | "command"
  | "test"
  | "review"
  | "security"
  | "approval"
  | "run-end"
  | "error";

export interface JournalEvent {
  at: string;
  type: JournalEventType;
  summary: string;
  data?: Record<string, unknown>;
}

export interface RunJournalOptions {
  repoRoot: string;
  runId: string;
  /** Set false to keep the run entirely out of the repository. */
  enabled?: boolean;
}

const MAX_TEXT_IN_JOURNAL = 20_000;

export class RunJournal {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly enabled: boolean;
  readonly runId: string;
  private readonly events: JournalEvent[] = [];

  constructor(options: RunJournalOptions) {
    this.runId = options.runId;
    this.enabled = options.enabled !== false;
    this.directory = path.join(options.repoRoot, ".canvil", "journal");
    this.filePath = path.join(this.directory, `${options.runId}.jsonl`);
  }

  get path(): string {
    return this.filePath;
  }

  get all(): readonly JournalEvent[] {
    return this.events;
  }

  record(type: JournalEventType, summary: string, data?: Record<string, unknown>): void {
    const event: JournalEvent = {
      at: new Date().toISOString(),
      type,
      summary: truncate(redactSecrets(summary), 2_000, "…"),
      ...(data ? { data: sanitize(data) } : {}),
    };
    this.events.push(event);
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // A read-only checkout must not fail a run because it cannot journal.
    }
  }

  /** Write the final summary next to the journal for quick inspection. */
  writeSummary(summary: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.writeFileSync(
        path.join(this.directory, `${this.runId}.summary.json`),
        `${stableStringify(summary)}\n`,
        "utf8",
      );
    } catch {
      // Ignored for the same reason as above.
    }
  }
}

function sanitize(value: Record<string, unknown>): Record<string, unknown>;
function sanitize(value: unknown, depth: number): unknown;
function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncate(redactSecrets(value), MAX_TEXT_IN_JOURNAL, "…");
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 6) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(token|secret|password|api[-_]?key|authorization)/i.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitize(entry, depth + 1);
    }
    return out;
  }
  return undefined;
}

/** Read a previous run's events; returns [] when the journal is absent. */
export function readJournal(repoRoot: string, runId: string): JournalEvent[] {
  const filePath = path.join(repoRoot, ".canvil", "journal", `${runId}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as JournalEvent;
      if (typeof parsed.type === "string" && typeof parsed.summary === "string") events.push(parsed);
    } catch {
      // A corrupted line is skipped, not fatal: journals are diagnostics.
    }
  }
  return events;
}

/** List previous runs, newest first. */
export function listRuns(repoRoot: string): Array<{ runId: string; path: string }> {
  const directory = path.join(repoRoot, ".canvil", "journal");
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => ({
      runId: entry.replace(/\.jsonl$/, ""),
      path: path.join(directory, entry),
    }))
    .sort((a, b) => b.runId.localeCompare(a.runId));
}

/** Generate a run id that sorts chronologically and is filesystem-safe. */
export function createRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}
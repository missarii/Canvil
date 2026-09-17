/**
 * Minimal structured logger.
 *
 * Rules: logs go to stderr (stdout stays clean for machine-readable output),
 * secrets never reach a log line, and levels are enforced by a single switch.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Prefix every message, e.g. the node name inside the graph. */
  scope?: string;
  /** Format for the payload; "pretty" is for humans, "json" for pipelines. */
  format?: "pretty" | "json";
  /** Injectable sink so tests can capture output. */
  sink?: (line: string) => void;
}

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
];

/** Redact known credential shapes anywhere in an arbitrary string. */
export function redactSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string | undefined) =>
      typeof prefix === "string" && prefix.toLowerCase().startsWith("bearer")
        ? `${prefix}[REDACTED]`
        : "[REDACTED]",
    );
  }
  return output;
}

function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(value);
  }
  if (depth > 4) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(key, item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = SECRET_KEY_PATTERN.test(childKey)
        ? "[REDACTED]"
        : redactValue(childKey, childValue, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly scope?: string;
  private readonly format: "pretty" | "json";
  private readonly sink: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.scope = options.scope;
    this.format = options.format ?? "pretty";
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** Derive a child logger that adds context to every line. */
  child(scope: string): Logger {
    return new Logger({
      level: this.level,
      scope: this.scope ? `${this.scope}:${scope}` : scope,
      format: this.format,
      sink: this.sink,
    });
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;
    const payload = data ? (redactValue("", data) as Record<string, unknown>) : undefined;
    if (this.format === "json") {
      this.sink(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          scope: this.scope ?? "canvil",
          message,
          ...(payload ? { data: payload } : {}),
        }),
      );
      return;
    }
    const stamp = new Date().toISOString().slice(11, 19);
    const label = level.toUpperCase().padEnd(5);
    const scope = this.scope ? ` [${this.scope}]` : "";
    const suffix = payload && Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : "";
    this.sink(`${stamp} ${label}${scope} ${redactSecrets(message)}${suffix}`);
  }
}

/** A logger that discards everything; handy in tests. */
export const silentLogger = new Logger({ level: "silent", sink: () => {} });
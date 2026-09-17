/**
 * Environment loading without a dotenv dependency.
 *
 * `.env` files are advisory: a variable already present in `process.env`
 * always wins, and a malformed `.env` never crashes the CLI.
 */

import fs from "node:fs";
import path from "node:path";
import type { CanvilEnv } from "./types.js";
import { ConfigError } from "../util/errors.js";

/** Parse a `.env` file body into key/value pairs. Supports quotes and `export`. */
export function parseDotEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;
    if (isDoubleQuoted) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
    } else if (isSingleQuoted) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load `.env` from the given directories into `process.env` without
 * overwriting anything already set. Returns the keys that were added.
 */
export function loadDotEnv(directories: string[], target: NodeJS.ProcessEnv = process.env): string[] {
  const added: string[] = [];
  for (const directory of directories) {
    for (const filename of [".env", ".env.local"]) {
      const filePath = path.join(directory, filename);
      if (!fs.existsSync(filePath)) continue;
      let parsed: Record<string, string>;
      try {
        parsed = parseDotEnv(fs.readFileSync(filePath, "utf8"));
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (target[key] === undefined) {
          target[key] = value;
          added.push(key);
        }
      }
    }
  }
  return added;
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Read Canvil's credentials from the environment. Absent values stay absent. */
export function readEnv(source: NodeJS.ProcessEnv = process.env): CanvilEnv {
  const env: CanvilEnv = {};
  const openaiApiKey = clean(source.OPENAI_API_KEY);
  const tavilyApiKey = clean(source.TAVILY_API_KEY);
  const braveApiKey = clean(source.BRAVE_API_KEY);
  const searxngUrl = clean(source.CANVIL_SEARXNG_URL);
  const githubToken = clean(source.GITHUB_TOKEN);
  if (openaiApiKey) env.openaiApiKey = openaiApiKey;
  if (tavilyApiKey) env.tavilyApiKey = tavilyApiKey;
  if (braveApiKey) env.braveApiKey = braveApiKey;
  if (searxngUrl) env.searxngUrl = searxngUrl;
  if (githubToken) env.githubToken = githubToken;
  return env;
}

/** Parse a boolean-ish env var, rejecting nonsense loudly. */
export function parseBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  const cleaned = clean(value)?.toLowerCase();
  if (cleaned === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(cleaned)) return true;
  if (["0", "false", "no", "off"].includes(cleaned)) return false;
  throw new ConfigError(`Environment variable ${name} must be a boolean, received "${value}"`);
}

/** Parse an integer env var with a floor of 1. */
export function parseIntegerEnv(name: string, value: string | undefined): number | undefined {
  const cleaned = clean(value);
  if (cleaned === undefined) return undefined;
  const parsed = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new ConfigError(`Environment variable ${name} must be a positive integer, received "${value}"`);
  }
  return parsed;
}

/** Parse a float env var (used for temperature, where 0 is legal). */
export function parseFloatEnv(name: string, value: string | undefined): number | undefined {
  const cleaned = clean(value);
  if (cleaned === undefined) return undefined;
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`Environment variable ${name} must be a number, received "${value}"`);
  }
  return parsed;
}
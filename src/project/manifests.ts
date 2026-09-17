/**
 * Manifest parsing.
 *
 * Only structured, machine-readable sources are read here: package.json,
 * pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle.
 * Every parser is defensive — a malformed manifest yields a warning, never a
 * crash, because Canvil still has to explain what it found.
 */

import fs from "node:fs";
import path from "node:path";

export interface ManifestFindings {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  name?: string;
  description?: string;
  workspaces: string[];
  packageManager?: string;
  warnings: string[];
}

export function emptyFindings(): ManifestFindings {
  return { dependencies: {}, devDependencies: {}, scripts: {}, workspaces: [], warnings: [] };
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") result[key] = entry;
    else if (entry && typeof entry === "object") result[key] = "workspace:*";
  }
  return result;
}

/** Parse package.json (also covers Bun and Deno-adjacent layouts). */
export function parsePackageJson(contents: string): ManifestFindings {
  const findings = emptyFindings();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents) as Record<string, unknown>;
  } catch (error) {
    findings.warnings.push(`package.json is not valid JSON: ${(error as Error).message}`);
    return findings;
  }

  if (typeof parsed.name === "string") findings.name = parsed.name;
  if (typeof parsed.description === "string") findings.description = parsed.description;
  findings.dependencies = asStringRecord(parsed.dependencies);
  findings.devDependencies = asStringRecord(parsed.devDependencies);
  // `peerDependencies` matter for framework plugins; treat them as real deps.
  findings.dependencies = { ...findings.dependencies, ...asStringRecord(parsed.peerDependencies) };
  findings.scripts = asStringRecord(parsed.scripts);

  if (typeof parsed.packageManager === "string") {
    findings.packageManager = parsed.packageManager.split("@")[0];
  }

  const workspaces = parsed.workspaces;
  if (Array.isArray(workspaces)) {
    findings.workspaces = workspaces.filter((entry): entry is string => typeof entry === "string");
  } else if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      findings.workspaces = packages.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return findings;
}

/** Extract names/versions from a PEP 621 / Poetry pyproject.toml. */
export function parsePyProject(contents: string): ManifestFindings {
  const findings = emptyFindings();
  const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(contents);
  if (nameMatch?.[1]) findings.name = nameMatch[1];
  const descriptionMatch = /^\s*description\s*=\s*["']([^"']+)["']/m.exec(contents);
  if (descriptionMatch?.[1]) findings.description = descriptionMatch[1];

  const dependencyBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(contents);
  if (dependencyBlock?.[1]) {
    for (const match of dependencyBlock[1].matchAll(
      /["']([A-Za-z0-9._-]+)\s*([<>=!~][^"']*)?["']/g,
    )) {
      if (match[1]) findings.dependencies[match[1].toLowerCase()] = (match[2] ?? "").trim() || "*";
    }
  }

  // Poetry style: [tool.poetry.dependencies] with `name = "^1.0"` lines.
  const poetryBlock = /\[tool\.poetry\.(dev-)?dependencies\]([\s\S]*?)(\n\[|$)/g;
  let poetryMatch: RegExpExecArray | null;
  while ((poetryMatch = poetryBlock.exec(contents)) !== null) {
    const isDev = poetryMatch[1] !== undefined;
    const body = poetryMatch[2] ?? "";
    for (const line of body.split("\n")) {
      const lineMatch = /^\s*([A-Za-z0-9._-]+)\s*=\s*["']?([^"'\n]+)["']?/.exec(line);
      if (!lineMatch?.[1]) continue;
      const key = lineMatch[1].toLowerCase();
      const version = (lineMatch[2] ?? "*").trim();
      if (isDev) findings.devDependencies[key] = version;
      else findings.dependencies[key] = version;
    }
  }

  const scriptBlock = /\[tool\.poetry\.scripts\]([\s\S]*?)(\n\[|$)/.exec(contents);
  if (scriptBlock?.[1]) {
    for (const line of scriptBlock[1].split("\n")) {
      const lineMatch = /^\s*([A-Za-z0-9._:-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (lineMatch?.[1] && lineMatch[2]) findings.scripts[lineMatch[1]] = lineMatch[2];
    }
  }
  return findings;
}

/** Parse requirements.txt style files. */
export function parseRequirements(contents: string): ManifestFindings {
  const findings = emptyFindings();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("-")) continue;
    const match = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*([<>=!~][^;#]*)?/.exec(line);
    if (!match?.[1]) continue;
    findings.dependencies[match[1].toLowerCase()] = (match[3] ?? "").trim() || "*";
  }
  return findings;
}

/** Parse go.mod: module name plus require directives. */
export function parseGoMod(contents: string): ManifestFindings {
  const findings = emptyFindings();
  const moduleMatch = /^module\s+(\S+)/m.exec(contents);
  if (moduleMatch?.[1]) findings.name = moduleMatch[1];

  for (const match of contents.matchAll(/^require\s+([^\s(]+)\s+(\S+)/gm)) {
    if (match[1]) findings.dependencies[match[1]] = match[2] ?? "*";
  }
  const blockMatch = /require\s*\(([\s\S]*?)\)/.exec(contents);
  if (blockMatch?.[1]) {
    for (const line of blockMatch[1].split("\n")) {
      const parts = line.trim().split(/\s+/);
      const name = parts[0];
      if (parts.length >= 2 && name && !name.startsWith("//")) {
        findings.dependencies[name] = parts[1] ?? "*";
      }
    }
  }
  return findings;
}

/** Parse Cargo.toml dependency tables (deliberately shallow). */
export function parseCargoToml(contents: string): ManifestFindings {
  const findings = emptyFindings();
  const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(contents);
  if (nameMatch?.[1]) findings.name = nameMatch[1];

  const blocks = contents.matchAll(/^\[(dependencies|dev-dependencies)\]\s*([\s\S]*?)(?=\n\[|$)/gm);
  for (const block of blocks) {
    const isDev = block[1] === "dev-dependencies";
    for (const line of (block[2] ?? "").split("\n")) {
      const lineMatch = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      if (!lineMatch?.[1] || !lineMatch[2]) continue;
      const version = /"([^"]+)"/.exec(lineMatch[2])?.[1] ?? "*";
      if (isDev) findings.devDependencies[lineMatch[1]] = version;
      else findings.dependencies[lineMatch[1]] = version;
    }
  }
  return findings;
}

/** Extract dependency names from pom.xml / build.gradle(.kts). */
export function parseJavaBuild(contents: string): ManifestFindings {
  const findings = emptyFindings();
  for (const match of contents.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
    if (match[1]) findings.dependencies[match[1].trim()] = "*";
  }
  for (const match of contents.matchAll(
    /(?:implementation|api|testImplementation|compile)\s*[( ]\s*["']([^"':]+):([^"':]+):?([^"')]*)/g,
  )) {
    if (match[2]) findings.dependencies[`${match[1]}:${match[2]}`] = match[3] || "*";
  }
  return findings;
}

/** Everything the manifest readers can contribute, merged in a fixed order. */
export function readManifests(root: string): ManifestFindings {
  const merged = emptyFindings();

  const merge = (findings: ManifestFindings, evidence: string): void => {
    merged.dependencies = { ...merged.dependencies, ...findings.dependencies };
    merged.devDependencies = { ...merged.devDependencies, ...findings.devDependencies };
    merged.scripts = { ...merged.scripts, ...findings.scripts };
    merged.workspaces = [...merged.workspaces, ...findings.workspaces];
    if (!merged.name && findings.name) merged.name = findings.name;
    if (!merged.description && findings.description) merged.description = findings.description;
    if (!merged.packageManager && findings.packageManager) {
      merged.packageManager = findings.packageManager;
    }
    merged.warnings = [...merged.warnings, ...findings.warnings.map((w) => `${evidence}: ${w}`)];
  };

  const packageJson = readIfExists(path.join(root, "package.json"));
  if (packageJson) merge(parsePackageJson(packageJson), "package.json");

  const pyproject = readIfExists(path.join(root, "pyproject.toml"));
  if (pyproject) merge(parsePyProject(pyproject), "pyproject.toml");

  for (const requirementsFile of [
    "requirements.txt",
    "requirements-dev.txt",
    "requirements/base.txt",
  ]) {
    const contents = readIfExists(path.join(root, requirementsFile));
    if (contents) merge(parseRequirements(contents), requirementsFile);
  }

  const goMod = readIfExists(path.join(root, "go.mod"));
  if (goMod) merge(parseGoMod(goMod), "go.mod");

  const cargoToml = readIfExists(path.join(root, "Cargo.toml"));
  if (cargoToml) merge(parseCargoToml(cargoToml), "Cargo.toml");

  for (const javaFile of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
    const contents = readIfExists(path.join(root, javaFile));
    if (contents) merge(parseJavaBuild(contents), javaFile);
  }

  return merged;
}
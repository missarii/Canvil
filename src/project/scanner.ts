/**
 * Project scanner.
 *
 * Answers "what am I actually working on?" before any model call. Everything it
 * produces is evidence-backed: each technology carries the file that proves it,
 * so the agent (and the user reviewing the run) can audit the inference.
 */

import fs from "node:fs";
import path from "node:path";
import type { DocumentationEntry, SourcesRegistry } from "../config/registries.js";
import { resolveDocumentation } from "../config/registries.js";
import { walkRepo } from "../tools/filesystem/walk.js";
import { toPosix } from "../util/paths.js";
import { readManifests } from "./manifests.js";
import {
  ARCHITECTURE_DIRECTORY_HINTS,
  EXTENSION_LANGUAGES,
  MARKER_FILE_LANGUAGES,
  technologyForDependency,
} from "./technology-map.js";
import type {
  DetectedTechnology,
  DocumentationLink,
  LanguageUsage,
  PackageManager,
  ProjectProfile,
} from "./types.js";

export interface ScanOptions {
  /** Documentation registry, used to attach official doc links. */
  documentation?: Map<string, DocumentationEntry>;
  sourcesRegistry?: SourcesRegistry;
  /** Extra files (repo-relative globs) that should never be scanned. */
  ignoreGlobs?: string[];
}

export function scanProject(root: string, options: ScanOptions = {}): ProjectProfile {
  const absoluteRoot = path.resolve(root);
  const warnings: string[] = [];

  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`Cannot scan "${root}": directory does not exist`);
  }

  const files = walkRepo(absoluteRoot, { maxFiles: 20_000, ignoreGlobs: options.ignoreGlobs });
  const relativePaths = files.map((file) => file.relativePath);
  const manifests = readManifests(absoluteRoot);
  warnings.push(...manifests.warnings);

  const languages = detectLanguages(absoluteRoot, relativePaths);
  const primaryLanguage = languages[0]?.name ?? "Unknown";

  const packageManager = detectPackageManager(
    absoluteRoot,
    relativePaths,
    manifests.packageManager,
  );

  const technologies = collectTechnologies({
    root: absoluteRoot,
    relativePaths,
    dependencies: manifests.dependencies,
    devDependencies: manifests.devDependencies,
    languages,
  });

  const technologyKeys = orderTechnologies(technologies);

  const commands = resolveCommands({
    root: absoluteRoot,
    relativePaths,
    scripts: manifests.scripts,
    packageManager,
    technologyKeys,
  });

  const docker = detectDocker(relativePaths);
  const ci = detectCi(relativePaths);
  const envVars = collectEnvVarNames(absoluteRoot, relativePaths);
  const architectureHints = ARCHITECTURE_DIRECTORY_HINTS.filter((hint) =>
    directoryExists(absoluteRoot, hint.directory),
  ).map((hint) => hint.hint);

  const workspaces = manifests.workspaces.map((workspace) => toPosix(workspace));
  const name = manifests.name ?? path.basename(absoluteRoot);

  const baseProfile: ProjectProfile = {
    root: absoluteRoot,
    name,
    languages,
    primaryLanguage,
    packageManager,
    technologies,
    technologyKeys,
    frameworks: technologiesWithCategory(technologies, "framework"),
    databases: technologiesWithCategory(technologies, "database"),
    orms: technologiesWithCategory(technologies, "orm"),
    testingFrameworks: technologiesWithCategory(technologies, "testing"),
    validationLibraries: technologiesWithCategory(technologies, "validation"),
    buildSystems: detectBuildSystems(relativePaths, packageManager),
    scripts: manifests.scripts,
    dependencies: manifests.dependencies,
    devDependencies: manifests.devDependencies,
    commands,
    docker,
    ci,
    envVars,
    monorepo: workspaces.length > 0 || relativePaths.some((file) => file.startsWith("packages/")),
    workspaces,
    fileCount: relativePaths.length,
    entrypoints: detectEntrypoints(relativePaths),
    configFiles: detectConfigFiles(relativePaths),
    architectureHints,
    documentation: [],
    warnings,
  };
  if (manifests.description) baseProfile.description = manifests.description;

  baseProfile.documentation = attachDocumentation(baseProfile, options.documentation);
  return baseProfile;
}

/* -------------------------------------------------------------------------- */
/* Languages                                                                  */
/* -------------------------------------------------------------------------- */

const LANGUAGE_FILE_CAP = 20_000;

function detectLanguages(root: string, relativePaths: string[]): LanguageUsage[] {
  const counts = new Map<string, number>();
  let scanned = 0;

  for (const relativePath of relativePaths) {
    if (scanned >= LANGUAGE_FILE_CAP) break;
    const extension = path.extname(relativePath).toLowerCase();
    const mapping = EXTENSION_LANGUAGES[extension];
    if (!mapping) continue;
    scanned += 1;
    counts.set(mapping.language, (counts.get(mapping.language) ?? 0) + 1);
  }

  // Manifest-only repositories (a fresh project) still have a language.
  if (counts.size === 0) {
    for (const marker of MARKER_FILE_LANGUAGES) {
      if (fs.existsSync(path.join(root, marker.file))) {
        counts.set(marker.language, 1);
        break;
      }
    }
  }

  const total = [...counts.values()].reduce((sum, value) => sum + value, 0) || 1;
  return [...counts.entries()]
    .map(([name, fileCount]) => ({ name, fileCount, share: Number((fileCount / total).toFixed(4)) }))
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* Package manager                                                            */
/* -------------------------------------------------------------------------- */

function detectPackageManager(
  root: string,
  relativePaths: string[],
  declared: string | undefined,
): PackageManager {
  const has = (file: string): boolean => fs.existsSync(path.join(root, file));

  // `packageManager` in package.json is the authoritative declaration.
  if (declared) {
    const lower = declared.toLowerCase();
    for (const known of ["npm", "pnpm", "yarn", "bun"] as const) {
      if (lower === known) return known;
    }
  }

  if (has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("package-lock.json")) return "npm";
  if (has("poetry.lock")) return "poetry";
  if (has("uv.lock")) return "uv";
  if (has("Pipfile")) return "pipenv";
  if (has("requirements.txt") || has("pyproject.toml")) return "pip";
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "cargo";
  if (has("pom.xml")) return "maven";
  if (has("build.gradle") || has("build.gradle.kts")) return "gradle";
  if (relativePaths.some((file) => file.endsWith(".csproj") || file.endsWith(".sln"))) {
    return "dotnet";
  }
  if (has("composer.json")) return "composer";
  if (has("Gemfile")) return "bundler";
  if (has("package.json")) return "npm";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Technologies                                                               */
/* -------------------------------------------------------------------------- */

interface CollectInput {
  root: string;
  relativePaths: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  languages: LanguageUsage[];
}

function collectTechnologies(input: CollectInput): DetectedTechnology[] {
  const found = new Map<string, DetectedTechnology>();

  const add = (technology: DetectedTechnology): void => {
    const existing = found.get(technology.key);
    // Prefer dependency evidence (it carries a version) over file evidence.
    if (!existing || (!existing.version && technology.version)) {
      found.set(technology.key, technology);
    }
  };

  for (const [name, version] of Object.entries(input.dependencies)) {
    const mapping = technologyForDependency(name);
    if (!mapping) continue;
    const technology: DetectedTechnology = {
      key: mapping.key,
      name,
      evidence: "package manifest",
      kind: `${mapping.category} dependency`,
    };
    if (version) technology.version = version;
    add(technology);
  }

  for (const [name, version] of Object.entries(input.devDependencies)) {
    const mapping = technologyForDependency(name);
    if (!mapping) continue;
    const technology: DetectedTechnology = {
      key: mapping.key,
      name,
      evidence: "package manifest (dev)",
      kind: `${mapping.category} devDependency`,
    };
    if (version) technology.version = version;
    add(technology);
  }

  for (const language of input.languages) {
    const marker = MARKER_FILE_LANGUAGES.find((entry) => entry.language === language.name);
    add({
      key: marker?.technologyKey ?? language.name.toLowerCase(),
      name: language.name,
      evidence: `${language.fileCount} source files`,
      kind: "language",
    });
  }

  for (const relativePath of input.relativePaths) {
    const lower = relativePath.toLowerCase();
    if (lower.endsWith("schema.prisma")) {
      add({ key: "prisma", name: "Prisma schema", evidence: relativePath, kind: "file" });
    }
    if (/(^|\/)dockerfile/.test(lower) || lower.endsWith("docker-compose.yml") || lower.endsWith("compose.yaml")) {
      add({ key: "docker", name: "Docker", evidence: relativePath, kind: "docker" });
    }
    if (lower.includes(".github/workflows/")) {
      add({ key: "github-actions", name: "GitHub Actions", evidence: relativePath, kind: "ci" });
    }
    if (lower.endsWith("tsconfig.json")) {
      add({ key: "typescript", name: "TypeScript", evidence: relativePath, kind: "file" });
    }
  }

  return [...found.values()];
}

/** Most-central-first ordering: frameworks, languages, data, then tooling. */
function orderTechnologies(technologies: DetectedTechnology[]): string[] {
  const rank = (technology: DetectedTechnology): number => {
    if (technology.kind.includes("framework")) return 0;
    if (technology.kind === "language") return 1;
    if (technology.kind.includes("orm") || technology.kind.includes("database")) return 2;
    if (technology.kind.includes("validation")) return 3;
    if (technology.kind.includes("testing")) return 4;
    if (technology.kind.includes("devDependency")) return 6;
    return 5;
  };
  const keys = [...technologies]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((technology) => technology.key);
  return [...new Set(keys)];
}

function technologiesWithCategory(technologies: DetectedTechnology[], category: string): string[] {
  const keys = technologies
    .filter(
      (technology) =>
        technology.kind.includes(category) ||
        technology.kind.split(" ")[0] === category,
    )
    .map((technology) => technology.key);
  return [...new Set(keys)];
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

interface CommandInput {
  root: string;
  relativePaths: string[];
  scripts: Record<string, string>;
  packageManager: PackageManager;
  technologyKeys: string[];
}

interface Commands {
  test?: string;
  build?: string;
  lint?: string;
  typecheck?: string;
  install?: string;
}

const TEST_SCRIPT_NAMES = ["test", "test:unit", "test:ci", "tests", "unit"];
const BUILD_SCRIPT_NAMES = ["build", "compile", "bundle"];
const LINT_SCRIPT_NAMES = ["lint", "lint:ci", "eslint"];
const TYPECHECK_SCRIPT_NAMES = ["typecheck", "type-check", "types", "check-types", "tsc"];

function firstScript(scripts: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const script = scripts[name];
    if (typeof script === "string" && script.trim().length > 0) return script.trim();
  }
  return undefined;
}

/** How the detected package manager invokes one of its scripts. */
function scriptInvocation(packageManager: PackageManager, scriptName: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

/**
 * Resolve the commands Canvil will actually run. package.json scripts win; when
 * they are missing, the ecosystem default is used so a fresh repository still
 * has something to verify against.
 */
function resolveCommands(input: CommandInput): Commands {
  const has = (file: string): boolean => fs.existsSync(path.join(input.root, file));
  const commands: Commands = {};
  const tech = new Set(input.technologyKeys);

  switch (input.packageManager) {
    case "npm":
      commands.install = has("package-lock.json") ? "npm ci" : "npm install";
      break;
    case "pnpm":
      commands.install = "pnpm install";
      break;
    case "yarn":
      commands.install = "yarn install";
      break;
    case "bun":
      commands.install = "bun install";
      break;
    case "poetry":
      commands.install = "poetry install";
      break;
    case "uv":
      commands.install = "uv sync";
      break;
    case "pip":
      commands.install = has("requirements.txt") ? "pip install -r requirements.txt" : undefined;
      break;
    case "go":
      commands.install = "go mod download";
      break;
    case "cargo":
      commands.install = "cargo fetch";
      break;
    case "maven":
      commands.install = "mvn install -DskipTests";
      break;
    case "gradle":
      commands.install = "./gradlew assemble -x test";
      break;
    case "dotnet":
      commands.install = "dotnet restore";
      break;
    default:
      break;
  }
  if (commands.install === undefined) delete commands.install;

  const packageManagerScript = (names: string[]): string | undefined => {
    for (const name of names) {
      if (input.scripts[name] !== undefined) return scriptInvocation(input.packageManager, name);
    }
    return undefined;
  };

  const rawTestScript = firstScript(input.scripts, TEST_SCRIPT_NAMES);
  const testScriptName = TEST_SCRIPT_NAMES.find((name) => input.scripts[name] !== undefined);
  if (testScriptName !== undefined && rawTestScript !== undefined) {
    // Watch-mode runners are forced into single-run mode so the agent can read
    // an exit code instead of hanging on a process that never ends.
    const nonInteractive = rawTestScript
      .replace(/\bvitest\b(?!\s+run)/, "vitest run")
      .replace(/\bjest\b(?!\s+--ci)/, "jest --ci --watchAll=false")
      .replace(/--watch(All)?\b/g, "");
    commands.test =
      nonInteractive === rawTestScript
        ? packageManagerScript(TEST_SCRIPT_NAMES)
        : `${scriptInvocation(input.packageManager, testScriptName)} -- ${nonInteractive}`;
  }

  if (commands.test === undefined) {
    if (tech.has("vitest")) commands.test = "npx vitest run";
    else if (tech.has("jest")) commands.test = "npx jest --ci";
    else if (tech.has("playwright")) commands.test = "npx playwright test";
    else if (tech.has("python")) commands.test = "python3 -m pytest";
    else if (tech.has("go")) commands.test = "go test ./...";
    else if (tech.has("rust")) commands.test = "cargo test";
    else if (tech.has("java")) commands.test = has("pom.xml") ? "mvn test" : "./gradlew test";
    else if (tech.has("dotnet")) commands.test = "dotnet test";
  }

  const buildInvocation = packageManagerScript(BUILD_SCRIPT_NAMES);
  if (buildInvocation) commands.build = buildInvocation;
  else if (has("tsconfig.json")) commands.build = "npx tsc --noEmit";
  else if (tech.has("go")) commands.build = "go build ./...";
  else if (tech.has("rust")) commands.build = "cargo build";
  else if (tech.has("java")) commands.build = has("pom.xml") ? "mvn compile" : undefined;
  else if (tech.has("dotnet")) commands.build = "dotnet build";
  if (commands.build === undefined) delete commands.build;

  const lintInvocation = packageManagerScript(LINT_SCRIPT_NAMES);
  if (lintInvocation) commands.lint = lintInvocation;
  else if (has(".eslintrc.json") || has("eslint.config.js") || has("eslint.config.mjs")) {
    commands.lint = "npx eslint .";
  }

  const typecheckInvocation = packageManagerScript(TYPECHECK_SCRIPT_NAMES);
  if (typecheckInvocation) commands.typecheck = typecheckInvocation;
  else if (has("tsconfig.json")) commands.typecheck = "npx tsc --noEmit";

  return commands;
}

/* -------------------------------------------------------------------------- */
/* Docker, CI, env, structure                                                 */
/* -------------------------------------------------------------------------- */

function detectDocker(relativePaths: string[]): ProjectProfile["docker"] {
  const files = relativePaths.filter((file) => {
    const lower = file.toLowerCase();
    return (
      /(^|\/)dockerfile[^/]*$/.test(lower) ||
      /(^|\/)(docker-)?compose(\.[^.]+)?\.ya?ml$/.test(lower) ||
      lower === ".dockerignore"
    );
  });
  return {
    hasDockerfile: files.some((file) => /(^|\/)dockerfile/.test(file.toLowerCase())),
    hasCompose: files.some((file) => /compose/.test(file.toLowerCase())),
    files,
  };
}

function detectCi(relativePaths: string[]): ProjectProfile["ci"] {
  const files: string[] = [];
  let provider: string | null = null;

  const workflows = relativePaths.filter((file) => file.startsWith(".github/workflows/"));
  if (workflows.length > 0) {
    files.push(...workflows);
    provider = "github-actions";
  }
  for (const [file, name] of [
    [".gitlab-ci.yml", "gitlab-ci"],
    [".circleci/config.yml", "circleci"],
    ["Jenkinsfile", "jenkins"],
    ["azure-pipelines.yml", "azure-pipelines"],
    [".buildkite/pipeline.yml", "buildkite"],
    [".drone.yml", "drone"],
  ] as const) {
    if (relativePaths.includes(file)) {
      files.push(file);
      provider = provider ?? name;
    }
  }
  return { provider, files };
}

/**
 * Read environment variable *names* only. Values are never captured, so a
 * committed `.env` cannot leak its contents into a prompt or a journal.
 */
function collectEnvVarNames(root: string, relativePaths: string[]): string[] {
  const names = new Set<string>();
  const envFiles = relativePaths.filter((file) => {
    const basename = path.basename(file);
    return basename === ".env" || basename.startsWith(".env.");
  });

  for (const file of envFiles) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
      const separator = withoutExport.indexOf("=");
      if (separator <= 0) continue;
      const name = withoutExport.slice(0, separator).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

const ENTRYPOINT_CANDIDATES = [
  "src/index.ts",
  "src/main.ts",
  "src/server.ts",
  "src/app.ts",
  "src/index.js",
  "src/main.js",
  "index.ts",
  "index.js",
  "server.ts",
  "main.ts",
  "main.py",
  "app.py",
  "manage.py",
  "cmd/main.go",
  "main.go",
  "src/main.rs",
  "Program.cs",
  "src/App.tsx",
  "pages/_app.tsx",
  "app/layout.tsx",
];

function detectEntrypoints(relativePaths: string[]): string[] {
  const found = ENTRYPOINT_CANDIDATES.filter((candidate) => relativePaths.includes(candidate));
  if (found.length === 0) {
    for (const file of relativePaths) {
      if (/^src\/[^/]*(index|main)\.[a-z]+$/.test(file)) found.push(file);
      if (found.length >= 5) break;
    }
  }
  return found.slice(0, 10);
}

const CONFIG_FILE_NAMES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  ".eslintrc.json",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  "prettier.config.js",
  "vitest.config.ts",
  "jest.config.js",
  "jest.config.ts",
  "playwright.config.ts",
  "vite.config.ts",
  "next.config.js",
  "next.config.ts",
  "nuxt.config.ts",
  "svelte.config.js",
  "angular.json",
  "tailwind.config.js",
  "tailwind.config.ts",
  "docker-compose.yml",
  "compose.yaml",
  "Dockerfile",
  "Makefile",
  ".editorconfig",
  ".nvmrc",
];

function detectConfigFiles(relativePaths: string[]): string[] {
  const present = CONFIG_FILE_NAMES.filter((name) => relativePaths.includes(name));
  for (const file of relativePaths) {
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(file)) present.push(file);
  }
  return present;
}

function directoryExists(root: string, relativeDirectory: string): boolean {
  try {
    return fs.statSync(path.join(root, relativeDirectory)).isDirectory();
  } catch {
    return false;
  }
}

function detectBuildSystems(relativePaths: string[], packageManager: PackageManager): string[] {
  const systems: string[] = [];
  const add = (value: string): void => {
    if (!systems.includes(value)) systems.push(value);
  };
  if (relativePaths.includes("package.json")) {
    add(packageManager === "unknown" ? "npm" : packageManager);
  }
  if (relativePaths.includes("Makefile")) add("make");
  if (relativePaths.includes("pom.xml")) add("maven");
  if (relativePaths.some((file) => file === "build.gradle" || file.endsWith("build.gradle.kts"))) {
    add("gradle");
  }
  if (relativePaths.includes("go.mod")) add("go");
  if (relativePaths.includes("Cargo.toml")) add("cargo");
  if (relativePaths.some((file) => file.endsWith(".csproj") || file.endsWith(".sln"))) add("dotnet");
  if (relativePaths.some((file) => file.endsWith(".tf"))) add("terraform");
  return systems;
}

/** Attach official documentation links resolved from the registry. */
function attachDocumentation(
  profile: ProjectProfile,
  registry: Map<string, DocumentationEntry> | undefined,
): DocumentationLink[] {
  if (!registry || registry.size === 0) return [];
  const links: DocumentationLink[] = [];
  for (const key of profile.technologyKeys) {
    const entry = resolveDocumentation(registry, key);
    if (!entry) continue;
    if (links.some((link) => link.url === entry.documentation)) continue;
    links.push({ technology: entry.key, name: entry.name, url: entry.documentation });
  }
  return links;
}
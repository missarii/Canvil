/**
 * Project profile: everything Canvil knows about the repository before it
 * changes a single line.
 *
 * This is the highest-trust context in the whole system. Research and RAG are
 * only consulted to fill the gaps this profile cannot answer.
 */

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "uv"
  | "pipenv"
  | "go"
  | "cargo"
  | "maven"
  | "gradle"
  | "dotnet"
  | "composer"
  | "bundler"
  | "unknown";

export interface LanguageUsage {
  name: string;
  fileCount: number;
  /** Share of source files, 0-1. */
  share: number;
}

export interface DetectedTechnology {
  /** Registry key from config/documentation.json, when resolvable. */
  key: string;
  name: string;
  /** Where it was detected: "package.json", "go.mod", "file:prisma/schema.prisma". */
  evidence: string;
  /** "dependency", "devDependency", "language", "file", "directory", "docker", "ci". */
  kind: string;
  version?: string;
}

export interface DocumentationLink {
  technology: string;
  name: string;
  url: string;
}

export interface ProjectProfile {
  root: string;
  name: string;
  description?: string;
  languages: LanguageUsage[];
  primaryLanguage: string;
  packageManager: PackageManager;
  technologies: DetectedTechnology[];
  /** Ordered list of distinct registry keys, most central first. */
  technologyKeys: string[];
  frameworks: string[];
  databases: string[];
  orms: string[];
  testingFrameworks: string[];
  validationLibraries: string[];
  buildSystems: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  commands: {
    test?: string;
    build?: string;
    lint?: string;
    typecheck?: string;
    install?: string;
  };
  docker: {
    hasDockerfile: boolean;
    hasCompose: boolean;
    files: string[];
  };
  ci: {
    provider: string | null;
    files: string[];
  };
  /** Environment variable *names* only; values are never read. */
  envVars: string[];
  monorepo: boolean;
  workspaces: string[];
  fileCount: number;
  entrypoints: string[];
  configFiles: string[];
  /** Structural hints such as "has-src-services", used to seed conventions. */
  architectureHints: string[];
  documentation: DocumentationLink[];
  warnings: string[];
}

/** A one-paragraph, prompt-ready description of the repository. */
export function describeProfile(profile: ProjectProfile): string {
  const lines: string[] = [];
  const stack = [
    profile.primaryLanguage,
    ...profile.frameworks,
    ...profile.databases,
    ...profile.orms,
    ...profile.testingFrameworks,
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

  lines.push(`Project: ${profile.name}`);
  if (profile.description) lines.push(`Description: ${profile.description}`);
  lines.push(`Primary language: ${profile.primaryLanguage}`);
  lines.push(`Stack: ${stack.length > 0 ? stack.join(", ") : "not detected"}`);
  lines.push(`Package manager: ${profile.packageManager}`);
  if (Object.keys(profile.commands).length > 0) {
    const commands = Object.entries(profile.commands)
      .map(([key, value]) => `${key}="${value}"`)
      .join(", ");
    lines.push(`Known commands: ${commands}`);
  }
  lines.push(
    `Testing: ${profile.testingFrameworks.length > 0 ? profile.testingFrameworks.join(", ") : "no test framework detected"}`,
  );
  lines.push(`Docker: ${profile.docker.hasDockerfile ? "yes" : "no"}`);
  lines.push(`CI: ${profile.ci.provider ?? "none detected"}`);
  if (profile.monorepo) lines.push(`Monorepo workspaces: ${profile.workspaces.join(", ")}`);
  if (profile.architectureHints.length > 0) {
    lines.push(`Structural signals: ${profile.architectureHints.join(", ")}`);
  }
  if (profile.warnings.length > 0) {
    lines.push(`Warnings: ${profile.warnings.join("; ")}`);
  }
  return lines.join("\n");
}
/**
 * Dependency name -> documentation registry key.
 *
 * Explicit rather than fuzzy on purpose: `pg` meaning PostgreSQL and `go`
 * meaning Go are exactly the kind of guesses an agent should not make silently.
 */

export type TechnologyCategory =
  | "framework"
  | "database"
  | "orm"
  | "testing"
  | "validation"
  | "runtime"
  | "language"
  | "tooling"
  | "cloud";

export interface TechnologyMapping {
  key: string;
  category: TechnologyCategory;
}

const M = (key: string, category: TechnologyCategory): TechnologyMapping => ({ key, category });

/** Exact dependency/package name matches (lower-cased keys). */
export const DEPENDENCY_TECHNOLOGIES: Record<string, TechnologyMapping> = {
  // JavaScript / TypeScript front end
  react: M("react", "framework"),
  "react-dom": M("react", "framework"),
  next: M("nextjs", "framework"),
  vue: M("vue", "framework"),
  nuxt: M("vue", "framework"),
  svelte: M("svelte", "framework"),
  "@sveltejs/kit": M("svelte", "framework"),
  "@angular/core": M("angular", "framework"),
  "@angular/cli": M("angular", "tooling"),
  vite: M("vite", "tooling"),
  "@vitejs/plugin-react": M("vite", "tooling"),
  tailwindcss: M("tailwindcss", "tooling"),

  // Node back ends
  "@nestjs/core": M("nestjs", "framework"),
  "@nestjs/common": M("nestjs", "framework"),
  "@nestjs/platform-express": M("nestjs", "framework"),
  "@nestjs/config": M("nestjs", "framework"),
  "@nestjs/passport": M("nestjs", "framework"),
  "@nestjs/jwt": M("nestjs", "framework"),
  express: M("express", "framework"),
  fastify: M("fastify", "framework"),
  koa: M("node", "framework"),
  "@hapi/hapi": M("node", "framework"),
  "@trpc/server": M("typescript", "framework"),
  graphql: M("javascript", "framework"),
  "@apollo/server": M("javascript", "framework"),

  // Languages / runtimes
  typescript: M("typescript", "language"),
  tsx: M("typescript", "tooling"),
  "ts-node": M("typescript", "tooling"),
  "@types/node": M("node", "runtime"),

  // Validation / schema
  zod: M("zod", "validation"),
  yup: M("javascript", "validation"),
  joi: M("javascript", "validation"),
  ajv: M("javascript", "validation"),
  "class-validator": M("typescript", "validation"),
  "class-transformer": M("typescript", "validation"),

  // ORM / data access
  prisma: M("prisma", "orm"),
  "@prisma/client": M("prisma", "orm"),
  "drizzle-orm": M("drizzle", "orm"),
  typeorm: M("typeorm", "orm"),
  sequelize: M("javascript", "orm"),
  mongoose: M("mongodb", "orm"),
  knex: M("javascript", "orm"),
  "@mikro-orm/core": M("javascript", "orm"),

  // Databases / drivers
  pg: M("postgresql", "database"),
  postgres: M("postgresql", "database"),
  postgresql: M("postgresql", "database"),
  "@vercel/postgres": M("postgresql", "database"),
  mysql2: M("mysql", "database"),
  mysql: M("mysql", "database"),
  mongodb: M("mongodb", "database"),
  redis: M("redis", "database"),
  ioredis: M("redis", "database"),
  "@upstash/redis": M("redis", "database"),
  sqlite3: M("javascript", "database"),
  "better-sqlite3": M("javascript", "database"),

  // Testing
  vitest: M("vitest", "testing"),
  jest: M("jest", "testing"),
  mocha: M("javascript", "testing"),
  "@playwright/test": M("playwright", "testing"),
  playwright: M("playwright", "testing"),
  cypress: M("javascript", "testing"),
  "@testing-library/react": M("react", "testing"),

  // Python
  pytest: M("python", "testing"),
  django: M("django", "framework"),
  fastapi: M("fastapi", "framework"),
  flask: M("flask", "framework"),
  sqlalchemy: M("python", "orm"),
  pydantic: M("python", "validation"),
  celery: M("python", "tooling"),
  uvicorn: M("fastapi", "runtime"),
  gunicorn: M("python", "runtime"),
  psycopg2: M("postgresql", "database"),
  psycopg: M("postgresql", "database"),
  asyncpg: M("postgresql", "database"),
  pymysql: M("mysql", "database"),
  pymongo: M("mongodb", "database"),
  motor: M("mongodb", "database"),
  boto3: M("aws", "cloud"),

  // Cloud / infra
  "@aws-sdk/client-s3": M("aws", "cloud"),
  "@aws-sdk/client-lambda": M("aws", "cloud"),
  "aws-sdk": M("aws", "cloud"),
  "aws-cdk-lib": M("aws", "cloud"),
  "firebase-admin": M("javascript", "cloud"),
  dockerode: M("docker", "cloud"),
  "@kubernetes/client-node": M("kubernetes", "cloud"),
};

/** Prefix rules for scoped families (e.g. `@nestjs/*`, `@aws-sdk/*`). */
export const PREFIX_TECHNOLOGIES: Array<{ prefix: string; mapping: TechnologyMapping }> = [
  { prefix: "@nestjs/", mapping: M("nestjs", "framework") },
  { prefix: "@aws-sdk/", mapping: M("aws", "cloud") },
  { prefix: "@angular/", mapping: M("angular", "framework") },
  { prefix: "@prisma/", mapping: M("prisma", "orm") },
  { prefix: "@types/", mapping: M("typescript", "tooling") },
  { prefix: "@mui/", mapping: M("react", "framework") },
  { prefix: "@tanstack/", mapping: M("react", "framework") },
  { prefix: "@trpc/", mapping: M("typescript", "framework") },
  { prefix: "django-", mapping: M("django", "framework") },
  { prefix: "fastapi-", mapping: M("fastapi", "framework") },
  { prefix: "flask-", mapping: M("flask", "framework") },
  { prefix: "nestjs-", mapping: M("nestjs", "framework") },
];

/** Resolve a package name to a documented technology, or undefined. */
export function technologyForDependency(name: string): TechnologyMapping | undefined {
  const lower = name.toLowerCase();
  const direct = DEPENDENCY_TECHNOLOGIES[lower];
  if (direct) return direct;
  for (const rule of PREFIX_TECHNOLOGIES) {
    if (lower.startsWith(rule.prefix)) return rule.mapping;
  }
  return undefined;
}

/** File extension -> language name (plus the registry key it maps to). */
export const EXTENSION_LANGUAGES: Record<string, { language: string; technologyKey?: string }> = {
  ".ts": { language: "TypeScript", technologyKey: "typescript" },
  ".tsx": { language: "TypeScript", technologyKey: "typescript" },
  ".mts": { language: "TypeScript", technologyKey: "typescript" },
  ".cts": { language: "TypeScript", technologyKey: "typescript" },
  ".js": { language: "JavaScript", technologyKey: "javascript" },
  ".jsx": { language: "JavaScript", technologyKey: "javascript" },
  ".mjs": { language: "JavaScript", technologyKey: "javascript" },
  ".cjs": { language: "JavaScript", technologyKey: "javascript" },
  ".vue": { language: "Vue", technologyKey: "vue" },
  ".svelte": { language: "Svelte", technologyKey: "svelte" },
  ".py": { language: "Python", technologyKey: "python" },
  ".rb": { language: "Ruby" },
  ".go": { language: "Go", technologyKey: "go" },
  ".rs": { language: "Rust", technologyKey: "rust" },
  ".java": { language: "Java", technologyKey: "java" },
  ".kt": { language: "Kotlin", technologyKey: "java" },
  ".kts": { language: "Kotlin", technologyKey: "java" },
  ".cs": { language: "C#", technologyKey: "dotnet" },
  ".php": { language: "PHP" },
  ".swift": { language: "Swift" },
  ".c": { language: "C" },
  ".h": { language: "C" },
  ".cc": { language: "C++" },
  ".cpp": { language: "C++" },
  ".hpp": { language: "C++" },
  ".scala": { language: "Scala" },
  ".ex": { language: "Elixir" },
  ".exs": { language: "Elixir" },
  ".dart": { language: "Dart" },
  ".sh": { language: "Shell" },
};

/** Files that indicate a language even when no source files exist yet. */
export const MARKER_FILE_LANGUAGES: Array<{ file: string; language: string; technologyKey?: string }> = [
  { file: "tsconfig.json", language: "TypeScript", technologyKey: "typescript" },
  { file: "jsconfig.json", language: "JavaScript", technologyKey: "javascript" },
  { file: "pyproject.toml", language: "Python", technologyKey: "python" },
  { file: "requirements.txt", language: "Python", technologyKey: "python" },
  { file: "setup.py", language: "Python", technologyKey: "python" },
  { file: "go.mod", language: "Go", technologyKey: "go" },
  { file: "Cargo.toml", language: "Rust", technologyKey: "rust" },
  { file: "pom.xml", language: "Java", technologyKey: "java" },
  { file: "build.gradle", language: "Java", technologyKey: "java" },
  { file: "Gemfile", language: "Ruby" },
  { file: "composer.json", language: "PHP" },
  { file: "mix.exs", language: "Elixir" },
];

/** Directory names that reveal an architectural style. */
export const ARCHITECTURE_DIRECTORY_HINTS: Array<{ directory: string; hint: string }> = [
  { directory: "src/controllers", hint: "layered-http-controllers" },
  { directory: "src/services", hint: "service-layer" },
  { directory: "src/domain", hint: "domain-layer" },
  { directory: "src/infrastructure", hint: "infrastructure-adapters" },
  { directory: "src/repositories", hint: "repository-pattern" },
  { directory: "src/repository", hint: "repository-pattern" },
  { directory: "src/usecases", hint: "use-case-layer" },
  { directory: "src/use-cases", hint: "use-case-layer" },
  { directory: "src/application", hint: "application-layer" },
  { directory: "src/entities", hint: "domain-entities" },
  { directory: "src/routes", hint: "route-module" },
  { directory: "src/handlers", hint: "handler-module" },
  { directory: "src/middleware", hint: "middleware-chain" },
  { directory: "src/guards", hint: "guard-based-authorization" },
  { directory: "src/modules", hint: "modular-monolith" },
  { directory: "src/features", hint: "feature-sliced" },
  { directory: "src/components", hint: "component-based-ui" },
  { directory: "src/hooks", hint: "react-hooks" },
  { directory: "src/store", hint: "central-store" },
  { directory: "src/stores", hint: "central-store" },
  { directory: "src/events", hint: "event-driven" },
  { directory: "src/consumers", hint: "event-driven" },
  { directory: "src/workers", hint: "background-workers" },
  { directory: "apps", hint: "monorepo-apps" },
  { directory: "packages", hint: "monorepo-packages" },
  { directory: "services", hint: "service-oriented" },
  { directory: "test", hint: "separate-test-tree" },
  { directory: "tests", hint: "separate-test-tree" },
  { directory: "__tests__", hint: "colocated-tests" },
];
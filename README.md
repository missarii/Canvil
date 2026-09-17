# Canvil

**An experimental TypeScript coding-agent architecture built with LangGraph, combining project intelligence, local knowledge retrieval, and live technical research.**

Canvil's goal is to understand an existing software project, consult authoritative sources when needed, plan a change, apply reviewable edits, and verify the result using the project's own tooling. This repository contains the core modules for that workflow; it is not yet a finished autonomous coding product.

## Development status

- TypeScript modules for project scanning, research, tools, orchestration, and reporting are implemented.
- The project builds with TypeScript. Focused HTTP/GitHub request tests use mocked network responses.
- **There is currently no CLI entry point.** The `start`, `dev`, and `bin` entries in `package.json` reference a missing CLI. Do not use them yet.
- End-to-end model-driven execution, Docker execution, and live research integrations have not been validated as a complete workflow.
- There is no web UI, API server, MCP server, durable graph checkpoint store, or automatic branch/commit workflow.

## Architecture

```text
                           CANVIL
                              |
              +---------------+----------------+
              |                                |
       CODING KNOWLEDGE                  LIVE RESEARCH
       Documentation registry            Web search
       GitHub source inspection           Page reading
       Curated local knowledge            Package APIs
              |                                |
              +---------------+----------------+
                              |
                     LangGraph agent state
                              |
                Project-aware implementation
                Files | Commands | Tests | Git
                              |
                    Review and run reporting
```

The compiled graph follows:

```text
inspect -> research -> plan -> code -> verify
                                  ^       |
                                  |       +-- passed -> review -> finalize
                                  |
                              diagnose <- failure
                                  |
                                  +-- more knowledge -> research
```

Routing includes iteration limits and failure finalization. Dependencies such as the model, executor, tool registry, logger, knowledge base, and approval handler are injected by a caller. The graph is compiled without persistent checkpointing.

## Knowledge paths

### Project intelligence

The scanner inspects manifests, language extensions, dependencies, package managers, framework markers, testing/build scripts, Docker and CI files, and architecture hints. A relevance scorer selects files for a budgeted context pack rather than reading every file into a prompt.

Detected versions and technologies are evidence from the repository, not a guarantee of compatibility. Monorepo and non-JavaScript support are heuristic and need broader fixture coverage.

### Coding knowledge

- **Documentation registry:** maps technology names and aliases to official documentation roots.
- **Source registry:** assigns source types and trust tiers for ranking.
- **GitHub readers:** search repositories/code, read repository files, and inspect releases.
- **Local retrieval:** heading-based Markdown chunks indexed with BM25 lexical scoring. This is **not embedding/vector search**; the retriever interface provides an extension point.
- **Curated content:** architecture, dependency injection, repository patterns, authentication, authorization, API security, TypeScript conventions, and testing guidance.

The intended evidence preference is the user's project first, official documentation next, then primary repositories and specialist sources before community/general web material. Ranking is a heuristic, not proof of correctness or protection against prompt injection.

### Live research

Web search selects the first configured provider: Tavily, Brave, then SearxNG. Without a provider, web search is unavailable and research should surface that limitation. Direct page reading is a separate capability.

The page reader uses Cheerio to extract readable text and code blocks. It is not a browser and does not execute client-side JavaScript. Structured package metadata readers cover npm and PyPI.

## Getting started

### Requirements

- A modern Node.js installation and npm. Validation for this snapshot used Node.js 25.6.0. The manifest's minimum Node version has not been tested against every locked dependency.
- Git for repository inspection.
- Docker for the container executor; not needed for the offline examples below.
- Credentials only when calling a model or authenticated network services.

### Install and validate

Clone the repository into a directory of your choice, then run from its root:

```sh
git clone https://github.com/missarii/Canvil.git
npm ci
npm run typecheck
npm run build
npm test
```

Run the npm commands **inside the cloned directory**, not its parent. A private repository requires access through your GitHub account.

### Try the implemented modules

After building, these commands run from the repository root without API credentials:

```sh
node --input-type=module -e 'import { scanProject } from "./dist/project/scanner.js"; console.log(JSON.stringify(scanProject(process.cwd()), null, 2));'

node --input-type=module -e 'import { createDefaultToolRegistry } from "./dist/tools/index.js"; console.table(createDefaultToolRegistry().summaries());'

node --input-type=module -e 'import { buildKnowledgeBase } from "./dist/knowledge/rag/knowledge-base.js"; console.log(buildKnowledgeBase().search("dependency injection", 3));'
```

These are inspection/retrieval examples, not an end-to-end agent launcher. Integrating the experimental graph requires supplying the `AgentDeps` interface and invoking `buildCanvilGraph` from a host application.

## Configuration

Configuration is merged in this order: built-in defaults, `config/canvil.config.json`, the target project's `.canvil/config.json`, and environment overrides. Only load project configuration you trust: it can change execution policy.

| Setting | Purpose |
| --- | --- |
| `CANVIL_MODEL_PROVIDER` | `openai` or the scripted `fake` test provider |
| `CANVIL_MODEL` | Model identifier |
| `CANVIL_MODEL_BASE_URL` | Optional OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | Model API credential |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | Search provider credentials |
| `CANVIL_SEARXNG_URL` | Alternative SearxNG search service |
| `GITHUB_TOKEN` | GitHub authentication; required for repository creation |
| `CANVIL_SANDBOX` | `docker` by default; `local` executes on the host |
| `CANVIL_SANDBOX_IMAGE` | Image with the project's required toolchain |
| `CANVIL_SANDBOX_NETWORK` | Container network access; disabled by default |
| `CANVIL_COMMAND_TIMEOUT_MS` | Command deadline |
| `CANVIL_MAX_ITERATIONS` | Bound on the coding/fix loop |
| `CANVIL_AUTO_APPROVE` | Controls write approval; leave disabled |

The environment template is `.env.example`. A host application must explicitly load environment files using the supplied helper or its own loader. Never commit populated credentials.

## Tools and extension points

- **Filesystem:** read, write, edit, list, and search repository files.
- **Terminal:** execute policy-checked commands and run tests.
- **Git:** inspect status, diffs, and history.
- **Web:** structured search and readable page extraction.
- **GitHub:** repository/code search, file and release reads, plus repository creation. Creation is a remote mutation, not read-only research; require explicit approval in any host integration.
- **Packages:** npm and PyPI metadata lookup.

Tools have Zod input schemas and effect metadata. `createDefaultToolRegistry()` constructs the registry; callers supply a `ToolContext` with configuration, credentials, fetch implementation, executor, and logger. Effect metadata does not itself enforce approval.

The model, executor, retriever, and injected graph dependencies are extension points. MCP adapters, vector storage, and durable checkpoints remain future work.

## Safety model and limitations

**This is experimental software, not a hardened security boundary. Use disposable copies of trusted projects and review every diff.**

The implementation includes workspace path checks, protected-write patterns, command allow/block lists, bounded execution, approval callbacks, source attribution, and heuristic security review. Docker execution defaults to network isolation and resource limits.

- An allowlist does not make project scripts or dependencies safe. Test/build scripts can execute arbitrary code.
- Docker mounts the target repository. Secrets within that mount may be accessible to executed code. Keep sensitive data outside the target tree.
- Local mode has no container isolation; do not use it on untrusted projects.
- Filesystem-tool protections do not constrain all shell-process writes.
- Redaction and secret detection are best-effort, not comprehensive data-loss prevention.
- Source ranking does not prevent prompt injection in research or repository content.
- Heuristic review may miss defects or produce false positives. It is not an audit or OWASP compliance certification.
- Research/model requests occur separately from the container. Disabling container networking does not disable those requests.
- Approval requires correct host integration. There is no finished approval UI, automatic rollback, or guaranteed durable resume.

Prepare an appropriate image and dependencies before executing with networking disabled. The supplied Dockerfile is a starting point, not a universal runtime for every detected language.

## Repository layout

```text
config/                 Documentation, source, and execution policy registries
knowledge-base/         Curated Markdown knowledge
src/agent/              LangGraph state, nodes, routing, prompts, reports
src/config/             Configuration and environment loading
src/knowledge/          Research, ranking, and lexical retrieval
src/memory/             Run journal support
src/project/            Manifest scanning and context selection
src/sandbox/            Command policy and executors
src/security/           Heuristic security scanner
src/tools/              Filesystem, terminal, Git, web, GitHub, packages
src/util/               Shared utilities
tests/                  Focused request tests
docker/sandbox/         Sandbox image definition
MainRoad.MD             Original architecture diagram
```

## Verification and contributing

Run `npm run typecheck`, `npm run build`, and `npm test` before submitting changes. The initial suite contains four mocked GitHub request tests covering GET, POST, PUT, JSON bodies, and HTTP failure reporting. It does **not** establish end-to-end correctness or sandbox safety.

Include focused tests and explain changes to trust, credentials, execution policy, or remote side effects. Avoid unnecessary dependencies. Never commit secrets, generated output, local workspaces, or run journals.

## Roadmap

1. Tested CLI/bootstrap layer for graph dependencies.
2. Deterministic graph tests for bounded repair and approval rejection.
3. Docker integration tests and stronger credential/network boundaries.
4. Opt-in live-provider integration tests and cost controls.
5. Broader scanner fixtures and retrieval quality evaluation.
6. Durable checkpoints and explicit human review/resume workflows.
7. MCP adapters and embedding-backed retrieval after core validation.

## Acknowledgments and license

Built on LangGraph, LangChain, TypeScript, Zod, and Cheerio, with Vitest tests. Security guidance draws on OWASP and CWE; these organizations do not endorse or certify this project.

Released under the [MIT License](LICENSE). See the license file for terms and warranty disclaimers.

/**
 * Prompts.
 *
 * Kept in one module so the rules the agent operates under are reviewable in a
 * single place. The system prompt encodes the project's trust ordering and the
 * engineering constraints that matter more than cleverness: smallest correct
 * diff, follow existing conventions, never invent an API.
 */

import type { ProjectProfile } from "../project/types.js";
import type { ContextPack } from "../project/analyzer.js";
import { describeProfile } from "../project/types.js";
import type { ResearchBundle } from "../knowledge/types.js";
import type { ImplementationPlan, Diagnosis } from "./schemas.js";
import { renderContextPack } from "../project/analyzer.js";

export const BASE_SYSTEM_PROMPT = `You are Canvil, an autonomous coding agent working inside a real repository.

## How you decide what to believe
1. The project itself (files, manifests, tests, git history) is the highest authority. If the code says X, X is true.
2. Official documentation and official repositories come next. Curated internal docs rank alongside them.
3. Community answers (Stack Overflow, blogs) are for troubleshooting only, never ground truth.
Never invent an API, flag, option or import. If you have not seen it in the project or in provided sources, say so instead of guessing.

## How you change code
- Make the smallest correct change. Do not refactor, rename, reformat or "improve" anything the task did not ask for.
- Follow the existing conventions of the repository: its structure, naming, error handling and test style.
- Match the surrounding code's style exactly, including quote style and semicolons.
- Never add a dependency unless the task cannot be done without it; if you do, explain why.
- Never touch secrets, .env files, keys, CI credentials or .git internals.
- Keep the code compiling. Type errors and lint failures are not acceptable outcomes.

## How you communicate
- Be concrete and terse. No filler, no self-congratulation.
- When you are unsure, state the uncertainty and what would resolve it.
- Always reference files by their repository-relative path.`;

export interface PromptContext {
  task: string;
  profile: ProjectProfile | null;
  contextPack: ContextPack | null;
  research: ResearchBundle | null;
  plan: ImplementationPlan | null;
  diagnosis: Diagnosis | null;
}

/** Repository facts block, shared by every node prompt. */
export function renderRepositoryContext(context: PromptContext): string {
  const sections: string[] = [`## Task\n${context.task}`];

  if (context.profile) {
    sections.push(`## Project profile\n${describeProfile(context.profile)}`);
    if (context.profile.documentation.length > 0) {
      sections.push(
        `## Official documentation roots\n${context.profile.documentation
          .map((link) => `- ${link.name}: ${link.url}`)
          .join("\n")}`,
      );
    }
  }

  if (context.contextPack && context.contextPack.files.length > 0) {
    sections.push(`## Relevant files\n${renderContextPack(context.contextPack)}`);
  }

  if (
    context.research &&
    (context.research.findings.length > 0 || context.research.sources.length > 0)
  ) {
    sections.push(renderResearchContext(context.research));
  }

  if (context.plan) {
    sections.push(
      `## Plan\n${context.plan.summary}\n${context.plan.steps
        .map((step, index) => `${index + 1}. ${step.description} [${step.files.join(", ")}]`)
        .join("\n")}`,
    );
  }

  if (context.diagnosis) {
    sections.push(
      `## Previous attempt failed\nRoot cause: ${context.diagnosis.rootCause}\nFix strategy: ${context.diagnosis.fixStrategy}`,
    );
  }

  return sections.join("\n\n");
}

/** Findings plus a numbered source list the model must cite by id. */
export function renderResearchContext(research: ResearchBundle): string {
  const lines: string[] = ["## Research"];
  if (research.technologies.length > 0) {
    lines.push(`Technologies in scope: ${research.technologies.join(", ")}`);
  }
  if (research.limitations.length > 0) {
    lines.push(`Limitations: ${research.limitations.join("; ")}`);
  }
  if (research.findings.length > 0) {
    lines.push(
      research.findings
        .map(
          (finding) =>
            `- [${finding.confidence}] ${finding.question}\n  ${finding.answer}` +
            (finding.caveats && finding.caveats.length > 0
              ? `\n  Caveats: ${finding.caveats.join("; ")}`
              : "") +
            `\n  Sources: ${finding.sources.join(", ") || "none"}`,
        )
        .join("\n"),
    );
  }
  if (research.sources.length > 0) {
    lines.push(
      "### Sources (cite by id)\n" +
        research.sources
          .slice(0, 25)
          .map(
            (source) =>
              `- ${source.id} [tier ${source.tier}, ${source.sourceType}] ${source.title}` +
              (source.url ? ` — ${source.url}` : ""),
          )
          .join("\n"),
    );
  }
  return lines.join("\n");
}

export interface ResearchPromptInput {
  task: string;
  profile: ProjectProfile | null;
  /** Local knowledge-base excerpts already retrieved. */
  localKnowledge: string;
  availableTechnologies: string[];
  remainingQueries: number;
  /** Focus queries produced by a failed-fix diagnosis, when present. */
  focusQueries: string[];
}

export const RESEARCH_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

## Your role now: research planner
Decide what must be known before implementing, and how to find it.
- Prefer the project and the local knowledge base over the web.
- Write precise, technology-scoped queries (include the framework name and version when known).
- Do not propose a query whose answer is already in the provided material.
- Set localOnlyEnough=true when the provided material already answers the question.`;

export function buildResearchPrompt(input: ResearchPromptInput): string {
  const sections = [`## Task\n${input.task}`];
  if (input.profile) sections.push(`## Project profile\n${describeProfile(input.profile)}`);
  if (input.availableTechnologies.length > 0) {
    sections.push(`## Documented technologies\n${input.availableTechnologies.join(", ")}`);
  }
  sections.push(
    input.localKnowledge.trim().length > 0
      ? `## Local knowledge base excerpts\n${input.localKnowledge}`
      : "## Local knowledge base excerpts\n(none matched this task)",
  );
  if (input.focusQueries.length > 0) {
    sections.push(
      `## Focus queries from the failed attempt\n${input.focusQueries.join("\n")}\n` +
        "Prioritise these: the previous attempt failed for a reason the current material does not explain.",
    );
  }
  sections.push(`You may issue at most ${input.remainingQueries} search queries.`);
  return sections.join("\n\n");
}

export const FINDINGS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

## Your role now: research synthesis
Extract only what the provided sources actually say.
- Cite sources by their id. Never cite an id that was not provided.
- If the sources do not answer a question, return a finding with confidence "low" and say what is missing.
- Prefer the highest-trust source when sources disagree, and record the disagreement as a caveat.`;

export function buildFindingsPrompt(research: ResearchBundle, questions: string[]): string {
  return [
    `## Questions\n${questions.map((question) => `- ${question}`).join("\n") || "- (no explicit questions)"}`,
    renderResearchContext(research),
    "Return findings that answer the questions above using only the sources listed.",
  ].join("\n\n");
}

export const PLAN_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

## Your role now: implementation planner
Produce a plan a reviewer could follow.
- Each step must name the files it touches and how to verify it.
- State the test strategy concretely, using the project's detected test command.
- List assumptions explicitly rather than burying them in prose.
- If the task is ambiguous, plan the smallest interpretation and record the ambiguity as an assumption.`;

export const CODE_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

## Your role now: implementer
Produce file operations, not prose.
- "create" and "overwrite" need the complete file content. "edit" needs oldText copied exactly from the file shown to you, including whitespace.
- Never edit a file you have not been shown. Ask for it in \`blocked\` instead.
- Keep every file self-consistent after the change: imports, exports and types must all line up.
- If tests exist for the area you are changing, extend them rather than only changing production code.
- Set \`blocked\` only when you genuinely cannot proceed.`;

export function buildCodePrompt(
  context: PromptContext,
  feedback: string | null,
  priorFiles: string[],
): string {
  const sections = [renderRepositoryContext(context)];
  if (priorFiles.length > 0) {
    sections.push(
      `## Files already changed in this run\n${priorFiles.map((file) => `- ${file}`).join("\n")}`,
    );
  }
  if (feedback) {
    sections.push(`## Verification feedback to address\n${feedback}`);
  }
  return sections.join("\n\n");
}

export const DIAGNOSIS_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

## Your role now: failure analyst
The verification step failed. Find the cause in the output provided.
- Distinguish a real product bug from a flaky, environmental or pre-existing failure, and say which it is.
- Be specific about file and symbol. "Something is wrong" is not a diagnosis.
- Set needsResearch=true only when the failure depends on knowledge you do not have.`;

export const REVIEW_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

## Your role now: reviewer
Review the diff as a senior engineer would.
- Report only issues you can point at in the diff. Do not restate what the change does.
- Blocking means it must not merge. Reserve it for correctness, security, data loss and broken builds.
- Respect the repository's existing conventions; a style preference is a nit at most.
- Say explicitly whether the change does what the task asked, and nothing more.`;

export function buildReviewPrompt(
  context: PromptContext,
  diff: string,
  testSummary: string,
): string {
  return [
    renderRepositoryContext(context),
    `## Test result\n${testSummary}`,
    `## Working tree diff\n\`\`\`diff\n${diff || "(empty)"}\n\`\`\``,
    "Return a verdict, comments pointing at specific files, and whether the change follows the project's conventions.",
  ].join("\n\n");
}
/**
 * `research` node.
 *
 * Local knowledge is always consulted first because it is free and
 * authoritative; the web is only asked for what the local material does not
 * cover. Findings then require citations, so the coding step cannot silently
 * rely on an uncited guess.
 */

import { gatherWebResearch } from "../../knowledge/research.js";
import { emptyResearchBundle, type ResearchBundle, type ResearchSource } from "../../knowledge/types.js";
import {
  buildFindingsPrompt,
  buildResearchPrompt,
  FINDINGS_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
} from "../prompts.js";
import { findingsSchema, researchPlanSchema, SCHEMA_NAMES } from "../schemas.js";
import { toolContextFor, type AgentDeps } from "./deps.js";
import { logLine, type CanvilStateType, type CanvilStateUpdate } from "../state.js";
import type { RagDocument } from "../../knowledge/rag/store.js";
import { rankSources, primarySources } from "../../knowledge/sources/ranking.js";

export function createResearchNode(deps: AgentDeps) {
  return async function research(state: CanvilStateType): Promise<CanvilStateUpdate> {
    deps.logger.info("Researching", { focusQueries: state.researchFocus.length });

    const bundle: ResearchBundle = state.research ?? emptyResearchBundle();
    const technologies = state.profile?.technologyKeys ?? [];
    const trace: string[] = [];

    // 1. Local knowledge base: always, before anything remote.
    const localQuery = [state.task, ...state.researchFocus].join(" ");
    const localHits = deps.knowledgeBase.search(localQuery, 6);
    const localSources: ResearchSource[] = deps.knowledgeBase.searchAsSources(localQuery, 6);
    bundle.technologies = [...new Set([...bundle.technologies, ...technologies])];

    if (localHits.length > 0) {
      trace.push(`local knowledge: ${localHits.length} relevant section(s)`);
    } else {
      bundle.limitations.push("The local knowledge base had nothing specific to this task.");
      trace.push("local knowledge: no match");
    }

    // 2. Research plan: decide what queries to issue (if any), scoped to the
    //    technologies detected in the project profile.
    const localKnowledgeText = localHits
      .map((hit) => {
        const doc: RagDocument = hit.document;
        return `### ${doc.heading} (${doc.source})\n${doc.content}`;
      })
      .join("\n\n");

    const researchPlan = await deps.model.structured({
      name: SCHEMA_NAMES.researchPlan,
      schema: researchPlanSchema,
      prompt: {
        system: RESEARCH_SYSTEM_PROMPT,
        user: buildResearchPrompt({
          task: state.task,
          profile: state.profile,
          localKnowledge: localKnowledgeText,
          availableTechnologies: technologies,
          remainingQueries: deps.maxResearchQueries,
          focusQueries: state.researchFocus,
        }),
      },
    });

    bundle.queries = [...new Set([...bundle.queries, ...researchPlan.queries.map((q) => q.query)])];
    trace.push(`research plan: ${researchPlan.queries.length} query/queries, localOnlyEnough=${researchPlan.localOnlyEnough}`);

    deps.journal.record("research-plan", "Research plan generated", {
      queries: researchPlan.queries,
      questions: researchPlan.questions,
      localOnlyEnough: researchPlan.localOnlyEnough,
    });

    // 3. Collect all sources to rank together. Local sources are ResearchSource[];
    //    web sources come back ranked. We merge them as ResearchSource[] and re-rank
    //    uniformly so tier always dominates lexical relevance.
    const allSources: ResearchSource[] = [...localSources, ...bundle.sources];

    // 3a. Web research, only when the local material is not enough.
    if (!researchPlan.localOnlyEnough && researchPlan.queries.length > 0) {
      const webResult = await gatherWebResearch({
        tools: deps.tools,
        toolContext: toolContextFor(deps, state),
        sourcesRegistry: deps.sourcesRegistry,
        queries: researchPlan.queries.map((q) => q.query),
        technologies,
        resultsPerQuery: deps.toolContext.config.limits.maxWebResults,
        maxPagesToRead: 5,
        logger: deps.logger,
        now: new Date(),
      });

      allSources.push(...webResult.sources);
      bundle.limitations.push(...webResult.limitations);
      trace.push(`web research: ${webResult.queriesRun.length} queries, ${webResult.sources.length} sources`);
    }

    // 4. Rank sources and extract findings: the distilled facts the coding step
    //    will rely on. Findings require citations drawn from the ranked list.
    const rankedSources = rankSources(allSources, localQuery, {
      registry: deps.sourcesRegistry,
      technologies,
    });
    bundle.sources = rankedSources;

    const primary = primarySources(rankedSources, 3);
    const findings = await deps.model.structured({
      name: SCHEMA_NAMES.findings,
      schema: findingsSchema,
      prompt: {
        system: FINDINGS_SYSTEM_PROMPT,
        user: buildFindingsPrompt(bundle, researchPlan.questions),
      },
    });

    bundle.findings = [...bundle.findings, ...findings.findings];
    trace.push(`findings: ${findings.findings.length} extracted`);

    deps.journal.record("research-findings", "Research findings extracted", {
      findings: findings.findings.map((f) => ({ question: f.question, confidence: f.confidence })),
      sourceCount: rankedSources.length,
      primary: primary.length,
    });

    const statusTrace = logLine("research complete");
    if (bundle.findings.some((f) => f.confidence !== "high")) {
      trace.push("one or more findings are low/medium confidence");
    }

    return {
      research: bundle,
      status: "planning",
      log: [...statusTrace, ...trace],
    };
  };
}
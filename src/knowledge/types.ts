/**
 * Shared knowledge types.
 *
 * A `ResearchSource` is the unit Canvil reasons about: it always carries where
 * it came from and how much it should be trusted, so citations survive all the
 * way into the final report.
 */

import type { SourceType } from "../config/registries.js";

export interface SourceIdentity {
  /** Stable id: URL when available, otherwise a synthetic `local:` / `memory:` id. */
  id: string;
}

export interface ResearchSource extends SourceIdentity {
  title: string;
  /** Absent for project-local and knowledge-base sources. */
  url?: string;
  sourceType: SourceType;
  /** Lower is more authoritative (1 = your project, 8 = general web). */
  tier: number;
  /** Documentation registry key this source belongs to, when known. */
  technology?: string;
  snippet: string;
  /** ISO timestamp of retrieval, so stale research is visible in the report. */
  retrievedAt: string;
  /** Set when the content came from the local knowledge base rather than the web. */
  local?: boolean;
}

export interface RankedSource extends ResearchSource {
  /** Final ordering score; higher is better. Combines tier and lexical relevance. */
  score: number;
  /** Human-readable justification, surfaced in the report. */
  rationale: string;
}

/** A research finding: the distilled statement Canvil will actually code against. */
export interface Finding {
  question: string;
  answer: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
  /** Anything the sources disagreed about, or that remains unverified. */
  caveats?: string[];
}

export interface ResearchBundle {
  queries: string[];
  sources: RankedSource[];
  findings: Finding[];
  /** Technologies the research planner decided were relevant. */
  technologies: string[];
  /** Reason research was skipped or truncated, if it was. */
  limitations: string[];
}

export function emptyResearchBundle(): ResearchBundle {
  return { queries: [], sources: [], findings: [], technologies: [], limitations: [] };
}
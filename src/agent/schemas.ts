/**
 * Structured output contracts.
 *
 * Every model interaction goes through a schema. Free-form text is not accepted
 * from the model anywhere — an autonomous agent that writes files needs a
 * machine-checkable contract, and a schema failure is a retryable error rather
 * than a corrupt repository.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Research                                                                   */
/* -------------------------------------------------------------------------- */

export const researchPlanSchema = z.object({
  /** Specific, technology-scoped queries rather than "how to code X". */
  queries: z
    .array(
      z.object({
        query: z
          .string()
          .min(3)
          .describe("A precise search query, e.g. 'NestJS 11 Google OAuth Passport strategy'"),
        rationale: z.string().min(3).describe("Why this query is needed"),
        technology: z.string().optional().describe("Documentation registry key to constrain to"),
      }),
    )
    .max(8),
  /** What the agent must know before implementing. */
  questions: z.array(z.string().min(3)).max(8),
  /** True when the task is answerable from the repository and knowledge base alone. */
  localOnlyEnough: z.boolean(),
});
export type ResearchPlan = z.infer<typeof researchPlanSchema>;

export const findingsSchema = z.object({
  findings: z
    .array(
      z.object({
        question: z.string().min(3),
        answer: z.string().min(3),
        confidence: z.enum(["high", "medium", "low"]),
        /** Source ids from the provided source list; must not be invented. */
        sources: z.array(z.string()),
        caveats: z.array(z.string()).optional(),
      }),
    )
    .max(12),
});
export type FindingsOutput = z.infer<typeof findingsSchema>;

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

export const planSchema = z.object({
  summary: z.string().min(5).describe("One paragraph describing the change"),
  steps: z
    .array(
      z.object({
        description: z.string().min(3),
        files: z.array(z.string()).describe("Repository-relative files this step touches"),
        verification: z.string().optional().describe("How to confirm the step is done"),
      }),
    )
    .min(1)
    .max(20),
  filesToCreate: z.array(z.string()),
  filesToModify: z.array(z.string()),
  testStrategy: z.string().min(3).describe("What will be tested, and with which command"),
  risks: z.array(z.string()).max(10),
  /** Anything the plan assumes but has not verified. */
  assumptions: z.array(z.string()).max(10),
});
export type ImplementationPlan = z.infer<typeof planSchema>;

/* -------------------------------------------------------------------------- */
/* Edits                                                                      */
/* -------------------------------------------------------------------------- */

export const fileOperationSchema = z.object({
  path: z.string().min(1).describe("Repository-relative path"),
  action: z.enum(["create", "overwrite", "edit"]),
  /** Required for create/overwrite: the complete file content. */
  content: z.string().optional(),
  /** Required for edit: exact existing text to replace. */
  oldText: z.string().optional(),
  /** Required for edit: replacement text. */
  newText: z.string().optional(),
  reason: z.string().optional(),
});
export type FileOperation = z.infer<typeof fileOperationSchema>;

export const codeResponseSchema = z.object({
  operations: z.array(fileOperationSchema).max(30),
  /** Commands the agent wants run after the operations are applied. */
  commands: z
    .array(z.object({ command: z.string().min(1), reason: z.string().optional() }))
    .max(6),
  notes: z.string().optional().describe("Anything the reviewer should know"),
  /** Set when the model cannot proceed without more information. */
  blocked: z.string().optional(),
});
export type CodeResponse = z.infer<typeof codeResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Diagnosis                                                                  */
/* -------------------------------------------------------------------------- */

export const diagnosisSchema = z.object({
  rootCause: z.string().min(5),
  /** Files worth reading to confirm the diagnosis. */
  suspectFiles: z.array(z.string()).max(10),
  fixStrategy: z.string().min(5),
  /** When true, the fix is likely to fail without more research. */
  needsResearch: z.boolean(),
  researchQueries: z.array(z.string()).max(5),
  /** True when the task appears unachievable as specified. */
  unrecoverable: z.boolean(),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

/* -------------------------------------------------------------------------- */
/* Review                                                                     */
/* -------------------------------------------------------------------------- */

export const reviewSchema = z.object({
  verdict: z.enum(["approve", "approve-with-comments", "request-changes"]),
  summary: z.string().min(3),
  comments: z
    .array(
      z.object({
        file: z.string(),
        severity: z.enum(["blocking", "important", "nit"]),
        comment: z.string().min(3),
        suggestion: z.string().optional(),
      }),
    )
    .max(20),
  /** Whether the change stays faithful to the project's existing conventions. */
  followsConventions: z.boolean(),
  conventionNotes: z.array(z.string()).max(10),
});
export type ReviewResult = z.infer<typeof reviewSchema>;

/** Schema names, used to route fake model responses in tests. */
export const SCHEMA_NAMES = {
  researchPlan: "research_plan",
  findings: "research_findings",
  plan: "implementation_plan",
  code: "code_change",
  diagnosis: "diagnosis",
  review: "code_review",
} as const;

export type SchemaName = (typeof SCHEMA_NAMES)[keyof typeof SCHEMA_NAMES];
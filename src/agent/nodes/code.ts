/**
 * `code` node: turn the plan into applied file operations.
 *
 * Three things make this safe rather than merely functional:
 *   1. Every write passes the human approval gate when that is configured.
 *   2. Every write goes through the filesystem tools, so the path jail and the
 *      protected-path policy apply even if the model asks for `.env`.
 *   3. A failed operation is recorded, not thrown — a partial application is
 *      reported honestly instead of leaving the run in an unknown state.
 */

import { buildCodePrompt, CODE_SYSTEM_PROMPT } from "../prompts.js";
import { codeResponseSchema, SCHEMA_NAMES, type FileOperation } from "../schemas.js";
import { promptContextFor, toolContextFor, type AgentDeps } from "./deps.js";
import {
  logLine,
  type AppliedEdit,
  type CanvilStateType,
  type CanvilStateUpdate,
  type CommandRecord,
} from "../state.js";
import { oneLine, truncate } from "../../util/text.js";
import { toError } from "../../util/errors.js";

interface CommandOutput {
  exitCode: number | null;
  isolation: CommandRecord["isolation"];
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export function createCodeNode(deps: AgentDeps) {
  return async function code(state: CanvilStateType): Promise<CanvilStateUpdate> {
    deps.logger.info("Implementing change", { iteration: state.iteration + 1 });

    const promptContext = promptContextFor(state);
    const priorFiles = state.edits.filter((edit) => edit.applied).map((edit) => edit.path);

    const response = await deps.model.structured({
      name: SCHEMA_NAMES.code,
      schema: codeResponseSchema,
      prompt: {
        system: CODE_SYSTEM_PROMPT,
        user: buildCodePrompt(promptContext, state.verificationFeedback, priorFiles),
      },
    });

    if (response.blocked && response.operations.length === 0) {
      deps.journal.record("edit", `Blocked: ${response.blocked}`, {});
      return {
        lastCodeResponse: response,
        status: "blocked",
        haltReason: response.blocked,
        log: logLine(`blocked: ${response.blocked}`),
        iteration: state.iteration + 1,
      };
    }

    if (deps.readOnly) {
      return {
        lastCodeResponse: response,
        status: "completed",
        haltReason: "Read-only run: the plan was produced but no file was modified.",
        log: logLine(
          `read-only run: ${response.operations.length} operation(s) proposed but not applied`,
        ),
        iteration: state.iteration + 1,
      };
    }

    const toolContext = toolContextFor(deps, state);
    const edits: AppliedEdit[] = [];
    const commands: CommandRecord[] = [];
    let autoApproveWrites = false;
    let autoApproveCommands = false;

    for (const operation of response.operations) {
      edits.push(
        await applyOperation(operation, deps, toolContext, {
          isAutoApproved: () => autoApproveWrites,
          markAutoApproved: () => {
            autoApproveWrites = true;
          },
        }),
      );
    }

    const approvalConfig = deps.toolContext.config.agent;
    for (const command of response.commands) {
      if (approvalConfig.requireApprovalForCommand && !autoApproveCommands) {
        const decision = await deps.approval({
          kind: "command",
          description: `Run command: ${command.command}`,
          command: command.command,
        });
        deps.journal.record("approval", `command ${decision}: ${command.command}`, {});
        if (decision === "reject") {
          commands.push({
            command: command.command,
            exitCode: null,
            isolation: "none",
            timedOut: false,
            durationMs: 0,
            output: "Rejected by the approval gate.",
            reason: command.reason ?? null,
            phase: "post-code",
          });
          continue;
        }
        if (decision === "approve-all") autoApproveCommands = true;
      }

      try {
        const result = (await deps.tools.invoke(
          "run_command",
          { command: command.command, ...(command.reason ? { reason: command.reason } : {}) },
          toolContext,
        )) as CommandOutput;

        commands.push({
          command: command.command,
          exitCode: result.exitCode,
          isolation: result.isolation,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          output: truncate(`${result.stdout}\n${result.stderr}`.trim(), 4_000),
          reason: command.reason ?? null,
          phase: "post-code",
        });
      } catch (error) {
        commands.push({
          command: command.command,
          exitCode: null,
          isolation: "none",
          timedOut: false,
          durationMs: 0,
          output: toError(error).message,
          reason: command.reason ?? null,
          phase: "post-code",
        });
      }
    }

    const appliedCount = edits.filter((edit) => edit.applied).length;
    const editsRejected = edits.some((edit) => !edit.applied);

    deps.journal.record("edit", `Applied ${appliedCount}/${edits.length} operation(s)`, {
      edits: edits.map((edit) => ({
        path: edit.path,
        action: edit.action,
        applied: edit.applied,
        reason: edit.reason,
      })),
      commands: commands.map((command) => ({ command: command.command, exit: command.exitCode })),
    });

    const trace = [...logLine(`code: applied ${appliedCount}/${edits.length} operation(s)`)];
    if (response.notes) trace.push(oneLine(`notes: ${response.notes}`, 300));
    if (editsRejected) trace.push("one or more operations were not applied (see the report)");

    return {
      lastCodeResponse: response,
      edits,
      commands,
      editsRejected,
      status: "verifying",
      iteration: state.iteration + 1,
      log: trace,
    };
  };
}

interface ApprovalGates {
  isAutoApproved: () => boolean;
  markAutoApproved: () => void;
}

async function applyOperation(
  operation: FileOperation,
  deps: AgentDeps,
  toolContext: ReturnType<typeof toolContextFor>,
  gates: ApprovalGates,
): Promise<AppliedEdit> {
  const base: AppliedEdit = {
    path: operation.path,
    action: operation.action,
    bytes: 0,
    created: false,
    reason: operation.reason ?? null,
    applied: false,
  };

  // Validate the operation's shape before asking for approval: there is no point
  // prompting a human about an edit the model did not finish describing.
  const incomplete =
    operation.action === "edit"
      ? !operation.oldText || operation.newText === undefined
      : operation.content === undefined;
  if (incomplete) {
    return {
      ...base,
      reason:
        `Model produced an incomplete "${operation.action}" operation ` +
        `(missing ${operation.action === "edit" ? "oldText/newText" : "content"})`,
    };
  }

  if (deps.toolContext.config.agent.requireApprovalForWrite && !gates.isAutoApproved()) {
    const decision = await deps.approval({
      kind: "write",
      description: `${operation.action} ${operation.path}`,
      paths: [operation.path],
    });
    deps.journal.record("approval", `write ${decision}: ${operation.path}`, {});
    if (decision === "reject") {
      return { ...base, reason: "Rejected by the approval gate" };
    }
    if (decision === "approve-all") gates.markAutoApproved();
  }

  try {
    if (operation.action === "edit") {
      const result = (await deps.tools.invoke(
        "edit_file",
        { path: operation.path, oldText: operation.oldText, newText: operation.newText },
        toolContext,
      )) as { replacements: number };
      return { ...base, applied: true, bytes: result.replacements };
    }

    const result = (await deps.tools.invoke(
      "write_file",
      {
        path: operation.path,
        content: operation.content,
        ...(operation.reason ? { reason: operation.reason } : {}),
      },
      toolContext,
    )) as { bytes: number; created: boolean };
    return { ...base, applied: true, bytes: result.bytes, created: result.created };
  } catch (error) {
    // A refused write (protected path, jail escape, ambiguous edit) is a normal
    // outcome of a policy, not a crash: record it and let the run continue.
    const message = toError(error).message;
    deps.logger.warn("File operation failed", { path: operation.path, error: message });
    return { ...base, reason: message };
  }
}
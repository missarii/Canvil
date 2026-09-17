/**
 * The tool registry.
 *
 * One place declares every capability Canvil has. The agent, the approval layer
 * and the `canvil tools` command all read from here, which is also what a future
 * MCP server would export.
 */

import { ToolRegistry } from "./types.js";
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  searchCodeTool,
  writeFileTool,
} from "./filesystem/files.js";
import { runCommandTool, runTestsTool } from "./terminal/index.js";
import { gitDiffTool, gitLogTool, gitStatusTool } from "./git/index.js";
import { readWebPageTool, webSearchTool } from "./web/index.js";
import {
  githubListReleasesTool,
  githubReadFileTool,
  githubSearchCodeTool,
  githubSearchRepositoriesTool,
  githubCreateRepositoryTool,
} from "./github/index.js";
import { packageInfoTool } from "./packages/registry.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

    registry
    .register(readFileTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(listFilesTool)
    .register(searchCodeTool)
    .register(runCommandTool)
    .register(runTestsTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(gitLogTool)
    .register(webSearchTool)
    .register(readWebPageTool)
    .register(githubSearchRepositoriesTool)
    .register(githubReadFileTool)
    .register(githubSearchCodeTool)
    .register(githubListReleasesTool)
    .register(githubCreateRepositoryTool)
    .register(packageInfoTool);

  return registry;
}

export { ToolRegistry } from "./types.js";
export type {
  CommandExecutor,
  CommandRequest,
  CommandResult,
  ToolContext,
  ToolDefinition,
  ToolEffect,
  ToolSummary,
} from "./types.js";
export { defineTool, noopExecutor, parseToolInput } from "./types.js";
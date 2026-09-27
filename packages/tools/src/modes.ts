// A12: what each work mode may do. A mode is enforced twice: its tools are the only ones offered
// to the model, and the gateway refuses any other call before execution (`mode_forbids`).
import type {
  BuiltinToolName,
  McpToolAnnotations,
  McpToolInfo,
  McpToolName,
  OperationClass,
  ToolName,
  WorkMode,
} from "@nova/shared";

const READ_TOOLS: readonly BuiltinToolName[] = ["read_file", "list_dir", "glob", "search_text", "git_status", "git_diff"];
const WEB_TOOLS: readonly BuiltinToolName[] = ["web_search", "fetch_page"];
const WRITE_TOOLS: readonly BuiltinToolName[] = ["write_file", "edit_file", "move_path", "delete_path"];
const RUN_TOOLS: readonly BuiltinToolName[] = ["run_command", "run_tests"];

const MODE_BUILTINS: Readonly<Record<WorkMode, readonly BuiltinToolName[]>> = {
  // Discuss: no project access, only the web when the contract allows it.
  discuss: WEB_TOOLS,
  understand: [...READ_TOOLS, ...WEB_TOOLS],
  plan: [...READ_TOOLS, ...WEB_TOOLS],
  build: [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS, "git_commit", ...WEB_TOOLS],
  fix: [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS, "git_commit", ...WEB_TOOLS],
  // Verify: runs checks, never writes code.
  verify: [...READ_TOOLS, ...RUN_TOOLS, ...WEB_TOOLS],
};

/** Operation classes a mode may perform (MCP tools are admitted by their operation). */
export const MODE_OPERATIONS: Readonly<Record<WorkMode, readonly OperationClass[]>> = {
  discuss: ["network"],
  understand: ["read", "network"],
  plan: ["read", "network"],
  build: ["read", "write", "delete", "execute", "network", "git_mutation", "external"],
  fix: ["read", "write", "delete", "execute", "network", "git_mutation", "external"],
  verify: ["read", "execute", "network"],
};

/**
 * Operation of an MCP tool from its (untrusted) hints: read-only and closed-world → `read`;
 * anything else may have effects NOVA cannot undo → `external` (asked every time, S6).
 */
export function mcpOperation(annotations: McpToolAnnotations): OperationClass {
  if (annotations.readOnlyHint === true && annotations.destructiveHint !== true && annotations.openWorldHint !== true) {
    return "read";
  }
  return "external";
}

/**
 * Tool set of a mission: the mode's built-ins (web tools only when `webSearch` for web_search;
 * fetch_page stays governed by the domain policy) plus enabled MCP tools whose operation the mode
 * allows and whose permission is not `deny`.
 */
export function toolsForMode(
  mode: WorkMode,
  options: { webSearch: boolean; mcpTools: readonly McpToolInfo[] },
): ReadonlySet<ToolName> {
  const allowed = new Set<ToolName>(
    MODE_BUILTINS[mode].filter((name) => name !== "web_search" || options.webSearch),
  );
  const operations = MODE_OPERATIONS[mode];
  for (const tool of options.mcpTools) {
    if (!tool.qualifiedName || tool.permission === "deny") continue;
    if (operations.includes(mcpOperation(tool.annotations))) allowed.add(tool.qualifiedName satisfies McpToolName);
  }
  return allowed;
}

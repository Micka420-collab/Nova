// A12: the tools a mission offers to the model. Built-ins come from the permission engine's own
// mode table (@nova/permissions `modeBuiltinTools`), so what is offered and what the engine allows
// never disagree; MCP tools are admitted when the mode allows their operation. The gateway still
// refuses anything outside this set before evaluation (`mode_forbids`).
import { MODE_OPERATIONS, modeBuiltinTools } from "@nova/permissions";
import type { McpToolName, OperationClass, ToolName, WorkMode } from "@nova/shared";

export function missionToolSet(
  mode: WorkMode,
  options: { webSearch: boolean; mcpTools: readonly { definition: { name: McpToolName; operation: OperationClass } }[] },
): ReadonlySet<ToolName> {
  const allowed = new Set<ToolName>(modeBuiltinTools(mode, options.webSearch));
  for (const tool of options.mcpTools) {
    // `web`/`contract`/`tests` allowances concern built-in network and commands, not MCP tools.
    if (MODE_OPERATIONS[mode][tool.definition.operation] === "yes") allowed.add(tool.definition.name);
  }
  return allowed;
}

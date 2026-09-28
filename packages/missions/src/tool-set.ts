// A12: the tools a mission offers to the model. Built-ins come from the permission engine's own
// mode table (@nova/permissions `modeBuiltinTools`), so what is offered and what the engine allows
// never disagree; MCP tools are admitted when the mode allows their operation. The gateway still
// refuses anything outside this set before evaluation (`mode_forbids`).
import { BUILTIN_TOOL_OPERATIONS, MODE_OPERATIONS, modeBuiltinTools } from "@nova/permissions";
import {
  DEFAULT_MISSION_HARNESS,
  type McpToolName,
  type MissionHarnessOptions,
  type OperationClass,
  type ToolName,
  type WorkMode,
} from "@nova/shared";

export function missionToolSet(
  mode: WorkMode,
  options: {
    webSearch: boolean;
    mcpTools: readonly { definition: { name: McpToolName; operation: OperationClass } }[];
    /** J2-B contract opt-ins; absent = all off. */
    harness?: MissionHarnessOptions;
  },
): ReadonlySet<ToolName> {
  const allowed = new Set<ToolName>(modeBuiltinTools(mode, options.webSearch));
  const harness = options.harness ?? DEFAULT_MISSION_HARNESS;
  // Opt-in tools still need the mode to allow their operation (discuss offers neither).
  const modeAllows = (tool: "run_chain" | "start_submission"): boolean =>
    MODE_OPERATIONS[mode][BUILTIN_TOOL_OPERATIONS[tool]] === "yes";
  if (harness.chain && modeAllows("run_chain")) allowed.add("run_chain");
  if (harness.subMissions && modeAllows("start_submission")) allowed.add("start_submission");
  for (const tool of options.mcpTools) {
    // `web`/`contract`/`tests` allowances concern built-in network and commands, not MCP tools.
    if (MODE_OPERATIONS[mode][tool.definition.operation] === "yes") allowed.add(tool.definition.name);
  }
  return allowed;
}

// Work modes (A12): what each mode may do, applied by the engine (not by the prompt).
import {
  BUILTIN_TOOL_NAMES,
  isBuiltinToolName,
  type BuiltinToolName,
  type OperationClass,
  type ToolName,
  type WorkMode,
} from "@nova/shared";

/**
 * Canonical operation of each built-in tool. The engine evaluates this one, whatever operation the
 * caller put on the request, so a mislabeled call cannot downgrade itself to `read`.
 */
export const BUILTIN_TOOL_OPERATIONS: Readonly<Record<BuiltinToolName, OperationClass>> = {
  read_file: "read",
  list_dir: "read",
  glob: "read",
  search_text: "read",
  write_file: "write",
  edit_file: "write",
  move_path: "write",
  delete_path: "delete",
  run_command: "execute",
  run_tests: "execute",
  git_status: "read",
  git_diff: "read",
  git_commit: "git_mutation",
  web_search: "network",
  fetch_page: "network",
};

export function effectiveOperation(tool: ToolName, requested: OperationClass): OperationClass {
  return isBuiltinToolName(tool) ? BUILTIN_TOOL_OPERATIONS[tool] : requested;
}

/**
 * How a mode treats an operation class:
 * - `yes`: allowed by the mode (the contract and profile still apply);
 * - `web`: network allowed only for web search when the contract enables it (D3, `discuss`);
 * - `contract`: network allowed only when the contract lists `network` or enables web search;
 * - `tests`: execution limited to the project's test/build commands (`verify`);
 * - `no`: refused with `mode_forbids`.
 */
export type ModeAllowance = "yes" | "web" | "contract" | "tests" | "no";

export const MODE_OPERATIONS: Readonly<Record<WorkMode, Readonly<Record<OperationClass, ModeAllowance>>>> = {
  discuss: { read: "no", write: "no", delete: "no", execute: "no", network: "web", git_mutation: "no", external: "no" },
  understand: { read: "yes", write: "no", delete: "no", execute: "no", network: "contract", git_mutation: "no", external: "no" },
  plan: { read: "yes", write: "no", delete: "no", execute: "no", network: "contract", git_mutation: "no", external: "no" },
  build: { read: "yes", write: "yes", delete: "yes", execute: "yes", network: "yes", git_mutation: "yes", external: "yes" },
  fix: { read: "yes", write: "yes", delete: "yes", execute: "yes", network: "yes", git_mutation: "yes", external: "yes" },
  verify: { read: "yes", write: "no", delete: "no", execute: "tests", network: "contract", git_mutation: "no", external: "no" },
};

/**
 * Built-in tools offered to the model in each mode, in BUILTIN_TOOL_NAMES order (prompt cache).
 * `discuss` only offers `web_search` (fetch_page needs a host policy the user sees in a mission).
 * The engine still refuses any call outside the mode (a tool the model invents is not trusted).
 */
export function modeBuiltinTools(mode: WorkMode, webSearch: boolean): BuiltinToolName[] {
  return BUILTIN_TOOL_NAMES.filter((tool) => {
    const allowance = MODE_OPERATIONS[mode][BUILTIN_TOOL_OPERATIONS[tool]];
    if (allowance === "no") return false;
    if (allowance === "web") return webSearch && tool === "web_search";
    if (allowance === "contract") return webSearch || tool !== "web_search";
    if (allowance === "tests") return tool === "run_tests";
    return true;
  });
}

/** Mode → built-in tool set (with web search enabled), for `ModeToolPolicy` consumers. */
export const MODE_TOOLS: Readonly<Record<WorkMode, ReadonlySet<ToolName>>> = {
  discuss: new Set(modeBuiltinTools("discuss", true)),
  understand: new Set(modeBuiltinTools("understand", true)),
  plan: new Set(modeBuiltinTools("plan", true)),
  build: new Set(modeBuiltinTools("build", true)),
  fix: new Set(modeBuiltinTools("fix", true)),
  verify: new Set(modeBuiltinTools("verify", true)),
};

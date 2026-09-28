// What Nomi is visibly doing (NOMI.md §6 axis 2), derived only from real tool events.
import { isMcpToolName, type ToolName } from "@nova/shared";

export const NOMI_ACTIVITIES = ["none", "reading", "searching", "editing", "running", "testing", "debugging"] as const;
export type NomiActivity = (typeof NOMI_ACTIVITIES)[number];

/** Activities that make Nomi `working` (the rest keep it `thinking`), NOMI.md §6 priorities 7–8. */
export const WORKING_ACTIVITIES: ReadonlySet<NomiActivity> = new Set(["editing", "running", "testing"]);

/**
 * Activity of a tool call. `debugging` is not a tool: it is a read or search started while the
 * mission has an unresolved failure (see `activityForToolStart`).
 */
export function activityForTool(name: ToolName): Exclude<NomiActivity, "none" | "debugging"> {
  if (isMcpToolName(name)) return "running";
  switch (name) {
    case "read_file":
    case "list_dir":
    case "glob":
    case "git_status":
    case "git_diff":
      return "reading";
    case "search_text":
    case "web_search":
    case "fetch_page":
      return "searching";
    case "write_file":
    case "edit_file":
    case "move_path":
    case "delete_path":
    case "git_commit":
      return "editing";
    case "run_command":
      return "running";
    case "run_tests":
      return "testing";
  }
  return "running";
}

/** A read/search that follows a failed test or command of the same mission is debugging. */
export function activityForToolStart(name: ToolName, hasUnresolvedFailure: boolean): NomiActivity {
  const activity = activityForTool(name);
  if (hasUnresolvedFailure && (activity === "reading" || activity === "searching")) return "debugging";
  return activity;
}

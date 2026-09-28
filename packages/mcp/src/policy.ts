// Per-tool permission (M5) and operation class of MCP tools. Annotations are HINTS, never proof:
// they only choose how cautious the default is; they never grant anything by themselves.
import type { McpToolAnnotations, McpToolPermission, OperationClass } from "@nova/shared";

export interface McpPermissionRule {
  workspaceId: string | null;
  permission: McpToolPermission;
}

/** Workspace rule, else global rule, else `ask` (the default for every MCP tool). */
export function effectivePermission(
  rules: readonly McpPermissionRule[],
  workspaceId: string | null,
): McpToolPermission {
  if (workspaceId !== null) {
    const local = rules.find((rule) => rule.workspaceId === workspaceId);
    if (local) return local.permission;
  }
  return rules.find((rule) => rule.workspaceId === null)?.permission ?? "ask";
}

/**
 * Operation class the permission engine reasons about. MCP defaults (spec, ToolAnnotations):
 * readOnlyHint=false, destructiveHint=true, openWorldHint=true. So a tool without hints is
 * `external` (never rememberable), like one that declares destructive or open-world effects.
 * Only a tool that explicitly declares itself closed-world and non-destructive falls back to the
 * transport's class (a local process for stdio, the network for HTTP).
 * A read-only hint never lowers an HTTP tool below `network`: its arguments leave the machine
 * whatever it reads, so the tainted-context and mode rules for outbound traffic must apply.
 */
export function mcpOperation(annotations: McpToolAnnotations, transport: "stdio" | "http"): OperationClass {
  if (annotations.readOnlyHint === true) return transport === "stdio" ? "read" : "network";
  const destructive = annotations.destructiveHint ?? true;
  const openWorld = annotations.openWorldHint ?? true;
  if (destructive || openWorld) return "external";
  return transport === "stdio" ? "execute" : "network";
}

/** What the manager proposes (the user confirms once): `allow` for declared read-only tools. */
export function proposedPermission(annotations: McpToolAnnotations): McpToolPermission {
  return annotations.readOnlyHint === true && annotations.destructiveHint !== true ? "allow" : "ask";
}

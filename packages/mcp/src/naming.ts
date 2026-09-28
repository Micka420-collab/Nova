// Model-facing names of MCP tools: `mcp__<server>__<tool>` (see mcpToolName in @nova/shared).
import { mcpToolName, type McpToolName } from "@nova/shared";

export interface NamingEntry {
  serverId: string;
  serverName: string;
  toolName: string;
}

const key = (entry: Pick<NamingEntry, "serverId" | "toolName">): string => `${entry.serverId}\u0000${entry.toolName}`;

/**
 * Assigns qualified names to every (server, tool) pair. A name that is too long, or already taken
 * by an earlier pair in (server name, server id, tool name) order, maps to null: that tool is not
 * offered to the model (two slugs can coincide, e.g. `read_file` and `read-file`, or a global and a
 * workspace server with the same name). The order is total, so the outcome is stable across runs.
 */
export function assignQualifiedNames(entries: readonly NamingEntry[]): Map<string, McpToolName | null> {
  const sorted = [...entries].sort(
    (a, b) =>
      compare(a.serverName, b.serverName) || compare(a.serverId, b.serverId) || compare(a.toolName, b.toolName),
  );
  const taken = new Set<string>();
  const result = new Map<string, McpToolName | null>();
  for (const entry of sorted) {
    const name = mcpToolName(entry.serverName, entry.toolName);
    if (name === null || taken.has(name.toLowerCase())) {
      result.set(key(entry), null);
      continue;
    }
    // Providers treat names case-sensitively, but a model confuses `Foo` and `foo`: keep one.
    taken.add(name.toLowerCase());
    result.set(key(entry), name);
  }
  return result;
}

export function qualifiedNameOf(
  names: ReadonlyMap<string, McpToolName | null>,
  serverId: string,
  toolName: string,
): McpToolName | null {
  return names.get(key({ serverId, toolName })) ?? null;
}

/** Plain code-point comparison (locale-independent, so the order never depends on the machine). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

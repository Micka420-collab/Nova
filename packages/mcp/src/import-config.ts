// Read-only import of a project `.mcp.json` (M3, decision D12: import with visible limits).
// Format verified on 27/09/2026 against the Claude Code docs (code.claude.com/docs/en/mcp):
//   { "mcpServers": { "<name>": { "command", "args", "env" } | { "type": "http" | "streamable-http",
//     "url", "headers" } | { "type": "sse" | "ws", … } } }
// with `${VAR}` / `${VAR:-default}` expansion in command, args, env, url and headers.
// NOVA never expands variables from its own environment: such values must be typed by the user.
// Nothing is saved here: the result is a list of drafts the manager shows before adding.
// TODO(D12): Claude Desktop (`claude_desktop_config.json`) and Cursor (`.cursor/mcp.json`) use a
// similar `mcpServers` object, but their exact fields were not verified: not supported yet.
import {
  McpServerInputSchema,
  type McpConfigValueInput,
  type McpImportDraft,
  type McpImportWarning,
  type McpServerInput,
} from "@nova/shared";

export type { McpImportDraft, McpImportWarning };

const VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/;
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const MAX_SERVERS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    out[key] = entry;
  }
  return out;
}

/** Values: `${…}` → to be provided; credential-like names → vault; the rest → plain. */
function importValues(
  values: Record<string, string>,
  needsValue: string[],
  warnings: Set<McpImportWarning>,
): Record<string, McpConfigValueInput> {
  const out: Record<string, McpConfigValueInput> = {};
  for (const [name, value] of Object.entries(values)) {
    if (VARIABLE.test(value)) {
      needsValue.push(name);
      warnings.add("variable_reference");
      continue;
    }
    if (CREDENTIAL_NAME.test(name) && value.length > 0) {
      out[name] = { kind: "secret", value };
      warnings.add("secret_in_file");
      continue;
    }
    out[name] = { kind: "plain", value };
  }
  return out;
}

function importEntry(
  name: string,
  raw: unknown,
  target: Pick<McpServerInput, "scope" | "workspaceId">,
): McpImportDraft {
  const warnings = new Set<McpImportWarning>();
  const needsValue: string[] = [];
  const draft = (input: McpServerInput | null): McpImportDraft => ({ name, input, needsValue, warnings: [...warnings] });
  if (!isRecord(raw)) {
    warnings.add("invalid_entry");
    return draft(null);
  }
  const type = raw["type"];
  if (type === "sse" || type === "ws") {
    warnings.add("unsupported_transport");
    return draft(null);
  }
  let transport: McpServerInput["transport"];
  if (type === "http" || type === "streamable-http") {
    const headers = stringMap(raw["headers"]);
    if (typeof raw["url"] !== "string" || !headers) {
      warnings.add("invalid_entry");
      return draft(null);
    }
    if (VARIABLE.test(raw["url"])) {
      needsValue.push("url");
      warnings.add("variable_reference");
    }
    transport = { type: "http", url: raw["url"], headers: importValues(headers, needsValue, warnings) };
  } else if ((type === undefined || type === "stdio") && typeof raw["command"] === "string") {
    const args = raw["args"] ?? [];
    const env = stringMap(raw["env"]);
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string") || !env) {
      warnings.add("invalid_entry");
      return draft(null);
    }
    if (VARIABLE.test(raw["command"])) needsValue.push("command");
    args.forEach((arg, index) => {
      if (VARIABLE.test(arg)) needsValue.push(`args[${index}]`);
    });
    if (needsValue.length > 0) warnings.add("variable_reference");
    warnings.add("runs_local_command");
    transport = { type: "stdio", command: raw["command"], args, env: importValues(env, needsValue, warnings) };
  } else {
    warnings.add("invalid_entry");
    return draft(null);
  }
  const parsed = McpServerInputSchema.safeParse({ name, transport, ...target, enabled: false });
  if (!parsed.success) {
    // An unexpanded `${…}` URL is not a valid URL yet: the user completes it in the form.
    if (!warnings.has("variable_reference")) warnings.add("invalid_entry");
    return draft(null);
  }
  return draft(parsed.data);
}

/**
 * Parses a `.mcp.json` text. Imported servers are DISABLED drafts (enabled: false) for `target`
 * scope; the user reviews each one. Throws only when the text is not JSON or has no
 * `mcpServers` object.
 */
export function parseProjectMcpJson(
  text: string,
  target: Pick<McpServerInput, "scope" | "workspaceId">,
): McpImportDraft[] {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root) || !isRecord(root["mcpServers"])) throw new Error("No mcpServers object");
  return Object.entries(root["mcpServers"])
    .slice(0, MAX_SERVERS)
    .map(([name, raw]) => importEntry(name.trim().slice(0, 100) || "serveur", raw, target));
}

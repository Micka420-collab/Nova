// Pure helpers of the MCP manager: form state ↔ contract input, validation, untrusted-text checks.
import {
  McpServerInputSchema,
  type McpConfigValue,
  type McpConfigValueInput,
  type McpServerConfig,
  type McpServerInput,
} from "@nova/shared";
import { fr } from "../../copy/fr";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,128}$/;
const VALUE_MAX = 4_000;

export interface KeyValueRow {
  /** React key only. */
  key: string;
  name: string;
  /** Plain value, or a NEW secret typed by the user (sent once, never shown back). */
  value: string;
  secret: boolean;
  /** Existing vault secret kept as is while `value` stays empty. */
  secretRef: string | null;
  hint: string | null;
}

export interface McpFormState {
  name: string;
  scope: "global" | "workspace";
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  env: KeyValueRow[];
  headers: KeyValueRow[];
  enabled: boolean;
}

let rowSequence = 0;
export function newRow(): KeyValueRow {
  rowSequence += 1;
  return { key: `row-${rowSequence}`, name: "", value: "", secret: false, secretRef: null, hint: null };
}

export function emptyForm(): McpFormState {
  return { name: "", scope: "global", transport: "stdio", command: "", args: "", url: "", env: [], headers: [], enabled: true };
}

function rowsFrom(values: Record<string, McpConfigValue>): KeyValueRow[] {
  return Object.entries(values).map(([name, value]) => ({
    ...newRow(),
    name,
    value: value.kind === "plain" ? value.value : "",
    secret: value.kind === "secret_ref",
    secretRef: value.kind === "secret_ref" ? value.secretRef : null,
    hint: value.kind === "secret_ref" ? value.hint : null,
  }));
}

export function formFromConfig(config: McpServerConfig): McpFormState {
  const base = { ...emptyForm(), name: config.name, scope: config.scope, enabled: config.enabled };
  if (config.transport.type === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: config.transport.command,
      args: config.transport.args.join("\n"),
      env: rowsFrom(config.transport.env),
    };
  }
  return { ...base, transport: "http", url: config.transport.url, headers: rowsFrom(config.transport.headers) };
}

export type FormErrors = Record<string, string>;

function rowValue(row: KeyValueRow): McpConfigValueInput | null {
  if (row.secret) {
    if (row.value !== "") return { kind: "secret", value: row.value };
    return row.secretRef ? { kind: "secret_ref", secretRef: row.secretRef } : null;
  }
  return { kind: "plain", value: row.value };
}

function collectRows(
  rows: KeyValueRow[],
  pattern: RegExp,
  nameError: string,
  errors: FormErrors,
): Record<string, McpConfigValueInput> {
  const out: Record<string, McpConfigValueInput> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "" && row.value === "" && !row.secretRef) continue;
    if (!pattern.test(name)) {
      errors[`${row.key}:name`] = nameError;
      continue;
    }
    if (name in out) {
      errors[`${row.key}:name`] = fr.extensions.errors.duplicate;
      continue;
    }
    if (row.value.length > VALUE_MAX) {
      errors[`${row.key}:value`] = fr.extensions.errors.tooLong;
      continue;
    }
    const value = rowValue(row);
    if (!value) {
      errors[`${row.key}:value`] = fr.extensions.errors.secretEmpty;
      continue;
    }
    out[name] = value;
  }
  return out;
}

export type FormResult = { ok: true; input: McpServerInput } | { ok: false; errors: FormErrors };

/** Validates the form and builds the contract input (same schema main applies). */
export function formToInput(form: McpFormState, workspaceId: string | null): FormResult {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = fr.extensions.errors.name;
  let transport: McpServerInput["transport"];
  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (!command) errors.command = fr.extensions.errors.command;
    const args = form.args.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const env = collectRows(form.env, ENV_NAME, fr.extensions.errors.envName, errors);
    transport = { type: "stdio", command, args, env };
  } else {
    const url = form.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) errors.url = fr.extensions.errors.url;
    const headers = collectRows(form.headers, HEADER_NAME, fr.extensions.errors.headerName, errors);
    transport = { type: "http", url, headers };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const scope = form.scope === "workspace" && workspaceId ? "workspace" : "global";
  const parsed = McpServerInputSchema.safeParse({
    name,
    transport,
    scope,
    workspaceId: scope === "workspace" ? workspaceId : null,
    enabled: form.enabled,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.includes("url") ? "url" : issue.path.includes("command") ? "command" : issue.path[0] === "name" ? "name" : "form";
      errors[field] ??= field === "url" ? fr.extensions.errors.url : fr.extensions.errors.invalid;
    }
    return { ok: false, errors };
  }
  return { ok: true, input: parsed.data };
}

/**
 * Server-provided text that addresses the model with instructions (prompt injection attempts). A
 * heuristic for the warning only: descriptions are always treated as data, flagged or not.
 */
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(all|any|the|previous|prior|above|earlier|your)\b/i,
  /\b(disregard|forget)\s+(all|any|the|previous|prior|your)\b/i,
  /\byou\s+(must|should always|are required to|have to)\b/i,
  /\balways\s+(call|use|run|invoke|send|include)\b/i,
  /\bnever\s+(tell|mention|reveal|inform)\b/i,
  /\bdo\s+not\s+(tell|mention|reveal|inform|ask)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\bbefore\s+(using|calling)\s+any\s+other\s+tool\b/i,
  /<\s*\/?\s*(system|instructions?|important)\s*>/i,
  /\bignore[sz]?\s+(tes|vos|les|toutes?)\s+(consignes|instructions|règles)/i,
  /\btu\s+dois\b/i,
  /\bvous\s+devez\b/i,
  /\bn['’]oublie\s+pas\s+de\b/i,
  /\bne\s+(dis|mentionne|révèle)\s+(rien|pas|jamais)\b/i,
];

export function detectImperativeText(description: string): boolean {
  return IMPERATIVE_PATTERNS.some((pattern) => pattern.test(description));
}

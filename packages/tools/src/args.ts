// Model argument parsing: JSON (repaired when needed) then zod validation. Never throws.
import { jsonrepair } from "jsonrepair";
import type { z } from "zod";
import type { ParsedToolArguments } from "./index";

function parseObject(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Parses the raw argument string of a tool call. An empty string means `{}` (models omit
 * arguments for tools without parameters). Invalid JSON is repaired with `jsonrepair` (trailing
 * commas, single quotes, truncated objects…); the repaired value must still pass the schema.
 */
export function parseToolArguments<Args>(raw: string, schema: z.ZodType<Args>): ParsedToolArguments<Args> {
  const text = raw.trim() === "" ? "{}" : raw;
  let value: unknown;
  let repaired = false;
  try {
    value = parseObject(text);
  } catch {
    try {
      value = parseObject(jsonrepair(text));
      repaired = true;
    } catch {
      return { ok: false, error: "arguments are not valid JSON; send a JSON object matching the tool schema" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `invalid arguments: ${describeIssues(parsed.error)}` };
  return { ok: true, args: parsed.data, repaired };
}

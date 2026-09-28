// Static checks of a « Chaîne » program before any host is started. They give the model a precise
// reason early; they are NOT the security boundary (the host's fresh context is): a program that
// slips past them still has no require, process, network, timers nor code generation.
import { Script } from "node:vm";
import { CHAIN_LIMITS, redactSecrets } from "@nova/shared";
import type { ChainProgramCheck } from "./protocol";

/**
 * The program is the body of an async function whose only parameters are `nova` and `console`.
 * It is compiled at the host's global scope (never inside the host's own closures), so it can
 * name nothing but its parameters and the JavaScript built-ins. Strict mode: no `with`, no
 * sloppy `this`. The directive shares the first line, so program line N is script line N + 1.
 */
export function wrapChainProgram(program: string): string {
  return `(async function (nova, console) { "use strict";\n${program}\n})`;
}

/** Offset that makes error positions point at the program's own lines. */
export const CHAIN_PROGRAM_LINE_OFFSET = -1;

const FORBIDDEN: readonly { pattern: RegExp; detail: string }[] = [
  { pattern: /\bimport\s*\(/, detail: "import() is not available: only `nova` and plain JavaScript" },
  { pattern: /\bimport\s*\.\s*meta\b/, detail: "import.meta is not available: only `nova` and plain JavaScript" },
  { pattern: /^\s*(?:import|export)\s/m, detail: "modules are not available: the program is the body of an async function" },
];

const PREVIEW_MAX = 2_000;

export function checkChainProgram(program: string, maxChars: number = CHAIN_LIMITS.programMaxChars): ChainProgramCheck {
  if (program.length > maxChars) {
    return { ok: false, reason: "too_large", detail: `the program has ${program.length} characters; the limit is ${maxChars}` };
  }
  if (program.trim() === "") return { ok: false, reason: "syntax", detail: "the program is empty" };
  for (const rule of FORBIDDEN) if (rule.pattern.test(program)) return { ok: false, reason: "forbidden_syntax", detail: rule.detail };
  try {
    // Compiling runs nothing: it only parses.
    const parsed = new Script(wrapChainProgram(program), { filename: "program.js", lineOffset: CHAIN_PROGRAM_LINE_OFFSET });
    void parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid program";
    return { ok: false, reason: "syntax", detail: `syntax error: ${message.slice(0, 300)}` };
  }
  return { ok: true };
}

/** What the timeline shows of a program (`chain.started.programPreview`): redacted, ≤ 2 000 chars. */
export function chainProgramPreview(program: string): string {
  const text = redactSecrets(program);
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

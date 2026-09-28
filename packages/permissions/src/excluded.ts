// Sensitive files the model never reads or writes (C8, UX 7.1): the canonical list and matcher
// live in @nova/shared (`isSensitivePath`, also used by files, search and the web guard). The user
// can still open such files in the editor; only agent tools are refused.
import { isSensitivePath, SENSITIVE_PATH_PATTERNS } from "@nova/shared";
import { matchesGlob } from "./glob";

/** The canonical C8 defaults (gitignore syntax), for display and tests. */
export const DEFAULT_EXCLUDED_PATTERNS: readonly string[] = SENSITIVE_PATH_PATTERNS;

/**
 * Matcher for `EvaluationContext.isExcludedPath`. `extraPatterns` come from `.novaignore` (read by
 * the workspace lane); they can only add exclusions, never remove the defaults.
 */
export function createExcludedPathMatcher(extraPatterns: readonly string[] = []): (path: string) => boolean {
  const extra = extraPatterns.map((pattern) => pattern.trim()).filter((pattern) => pattern !== "" && !pattern.startsWith("#") && !pattern.startsWith("!"));
  return (path) => path !== "" && (isSensitivePath(path) || extra.some((pattern) => matchesGlob(path, pattern)));
}

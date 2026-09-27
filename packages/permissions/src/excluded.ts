// Sensitive files the model never reads or writes (C8, UX 7.1): secrets, keys, credentials.
// The list is conservative on purpose: `.env.example` is excluded too (it matches `.env*`); the user
// can still open such files in the editor, only agent tools are refused.
import { matchesGlob } from "./glob";

export const DEFAULT_EXCLUDED_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".ssh",
  ".gnupg",
  "**/.aws/credentials",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
];

/**
 * Matcher for `EvaluationContext.isExcludedPath`. `extraPatterns` come from `.novaignore` (read by
 * the workspace lane); they can only add exclusions, never remove the defaults.
 */
export function createExcludedPathMatcher(extraPatterns: readonly string[] = []): (path: string) => boolean {
  const patterns = [...DEFAULT_EXCLUDED_PATTERNS, ...extraPatterns.filter((pattern) => pattern.trim() !== "")];
  return (path) => path !== "" && patterns.some((pattern) => matchesGlob(path, pattern));
}

// C8: secret detection before content leaves the device (sent to a model, a web tool or an MCP
// server). The scan BLOCKS and explains (findings with line/column and a masked preview) rather
// than silently rewriting code; `redactSensitive` is for logs and error details only.
// Patterns favor precision: fixed prefixes and lengths of real token formats, so ordinary code is
// not flagged.
// The shapes and the scanner are canonical in @nova/shared (./sensitive), re-exported here.
import { redactSecrets, scanForSecrets, type RelativePath, type SecretFinding } from "@nova/shared";

export { scanForSecrets, type SecretFinding, type SecretKind } from "@nova/shared";

/** Masks every known secret shape. For logs and errors. */
export function redactSensitive(text: string): string {
  return redactSecrets(text);
}

export type OutgoingCheck =
  | { allowed: true }
  | { allowed: false; reason: "excluded_path"; path: RelativePath }
  | { allowed: false; reason: "secrets"; path: RelativePath | null; findings: SecretFinding[] };

/**
 * Decides whether content may leave the device. Excluded paths (C8) are refused whatever their
 * content; otherwise any secret finding blocks, with the findings to show the user.
 */
export function checkOutgoingContent(input: {
  path: RelativePath | null;
  content: string;
  isExcluded?: (path: RelativePath) => boolean;
}): OutgoingCheck {
  if (input.path !== null && input.isExcluded?.(input.path)) {
    return { allowed: false, reason: "excluded_path", path: input.path };
  }
  const findings = scanForSecrets(input.content);
  return findings.length === 0 ? { allowed: true } : { allowed: false, reason: "secrets", path: input.path, findings };
}

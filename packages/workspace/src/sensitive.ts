// C8: secret detection before content leaves the device (sent to a model, a web tool or an MCP
// server). The scan BLOCKS and explains (findings with line/column and a masked preview) rather
// than silently rewriting code; `redactSensitive` is for logs and error details only.
// Patterns favor precision: fixed prefixes and lengths of real token formats, so ordinary code is
// not flagged.
import { redactSecrets, type RelativePath } from "@nova/shared";

export type SecretKind =
  | "private_key"
  | "aws_access_key"
  | "aws_secret_key"
  | "github_token"
  | "jwt"
  | "connection_string"
  | "api_key"
  | "slack_token"
  | "google_api_key"
  | "stripe_key"
  | "bearer_token";

export interface SecretFinding {
  kind: SecretKind;
  /** 1-based. */
  line: number;
  /** 1-based, UTF-16 units. */
  column: number;
  /** Masked: a known prefix at most, never the secret part. */
  preview: string;
}

interface SecretPattern {
  kind: SecretKind;
  regex: RegExp;
  /** Characters of the match that are safe to show (a public prefix like `ghp_`). */
  visible: number;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private_key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    visible: 11,
  },
  { kind: "aws_access_key", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, visible: 4 },
  {
    kind: "aws_secret_key",
    regex: /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    visible: 21,
  },
  { kind: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, visible: 4 },
  { kind: "github_token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, visible: 11 },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, visible: 3 },
  {
    kind: "connection_string",
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:/@"'`]+:[^\s@/"'`]+@[^\s"'`]+/gi,
    visible: 0,
  },
  { kind: "api_key", regex: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, visible: 3 },
  { kind: "slack_token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, visible: 5 },
  { kind: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, visible: 4 },
  { kind: "stripe_key", regex: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g, visible: 8 },
  { kind: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, visible: 7 },
];

const MASK = "[secret masqué]";

function preview(match: string, pattern: SecretPattern): string {
  if (pattern.kind === "connection_string") {
    const scheme = /^[a-z+]+:\/\//i.exec(match)?.[0] ?? "";
    return `${scheme}…:…@…`;
  }
  return `${match.slice(0, pattern.visible)}…`;
}

/** Line starts of `text`, for offset → line/column conversion. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function position(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] as number) + 1 };
}

/** Every secret-looking token of `text`, in text order (capped). */
export function scanForSecrets(text: string, maxFindings = 50): SecretFinding[] {
  const found: { offset: number; finding: SecretFinding }[] = [];
  let starts: number[] | null = null;
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      starts ??= lineStarts(text);
      const offset = match.index;
      found.push({ offset, finding: { kind: pattern.kind, ...position(starts, offset), preview: preview(match[0], pattern) } });
      if (found.length >= maxFindings * 2) break;
    }
  }
  return found
    .sort((a, b) => a.offset - b.offset)
    .slice(0, maxFindings)
    .map((entry) => entry.finding);
}

/** Masks every known secret shape (the shared patterns plus the C8 ones). For logs and errors. */
export function redactSensitive(text: string): string {
  let out = redactSecrets(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern.regex, MASK);
  return out;
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

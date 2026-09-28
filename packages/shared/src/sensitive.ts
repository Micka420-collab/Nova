// C8, the ONE canonical definition of what NOVA treats as sensitive:
// - paths the agent never reads, writes or sends (files, search, tools, web anti-exfiltration all
//   use `isSensitivePath`; `.novaignore` can only add to it);
// - secret shapes found in text before it leaves the device (`scanForSecrets`) and masked in logs,
//   errors and exports (`redactSecrets` in ./redact uses the same list).
// Dependency-free: imported by main, the workers, the permission engine and the renderer
// (Réglages shows the list).

/**
 * Default exclusions, gitignore syntax (the same text is fed to the `ignore` matcher of
 * `.novaignore`). `!` re-includes templates meant to be committed and public keys. A trailing `/`
 * marks a directory: everything below it is excluded.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  ".git/",
  "node_modules/",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
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
  "!*.pub",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials.json",
  "service-account*.json",
  "*.tfstate",
  "*.tfstate.*",
];

interface ParsedPathPattern {
  negate: boolean;
  regex: RegExp;
}

function segmentRegex(glob: string): RegExp {
  let source = "";
  for (const char of glob) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  // Case-insensitive on every platform: NTFS and default APFS open `.ENV` as `.env`, and a
  // security default must not depend on the filesystem the workspace sits on.
  return new RegExp(`^${source}$`, "i");
}

// Windows opens `.env.` / `.env ` as `.env` (trailing dots and spaces are dropped) and `.env::$DATA`
// as its main stream: compare the name the OS resolves to, not the spelling. Harmless elsewhere
// (at worst a real `a.pem.` file on Linux is also treated as sensitive).
function resolvedSegmentName(segment: string): string {
  const stream = segment.indexOf(":");
  return (stream === -1 ? segment : segment.slice(0, stream)).replace(/[. ]+$/, "");
}

// Every default is a single-segment pattern (no inner `/`): it matches a path component at any depth.
const PARSED_PATTERNS: readonly ParsedPathPattern[] = SENSITIVE_PATH_PATTERNS.map((pattern) => {
  const negate = pattern.startsWith("!");
  const body = (negate ? pattern.slice(1) : pattern).replace(/\/$/, "");
  return { negate, regex: segmentRegex(body) };
});

/**
 * True when a canonical relative path ("a/b/c") is excluded by the defaults. gitignore semantics:
 * last matching pattern wins per component, and nothing below an excluded folder can be
 * re-included. The last component is tested as a file and as a folder (`.ssh` itself is excluded).
 * Components are compared as the OS resolves them: case-insensitively, without a Windows stream
 * suffix or trailing dots and spaces.
 */
export function isSensitivePath(path: string): boolean {
  if (path === "" || path === ".") return false;
  for (const segment of path.split("/").map(resolvedSegmentName)) {
    let excluded = false;
    for (const pattern of PARSED_PATTERNS) if (pattern.regex.test(segment)) excluded = !pattern.negate;
    if (excluded) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Secret shapes

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

export interface SecretPattern {
  kind: SecretKind;
  /** French label for explanations ("NOVA a bloqué… : clé AWS"). */
  label: string;
  /** Global regex (use with matchAll/replace only: `test` on a global regex is stateful). */
  regex: RegExp;
  /** Characters of the match that are safe to show (a public prefix like `ghp_`). */
  visible: number;
}

/** Precision first: fixed prefixes and lengths of real token formats, so ordinary code is not flagged. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: "private_key",
    label: "clé privée",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    visible: 11,
  },
  { kind: "aws_access_key", label: "clé AWS", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, visible: 4 },
  {
    kind: "aws_secret_key",
    label: "clé secrète AWS",
    regex: /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
    visible: 21,
  },
  { kind: "github_token", label: "jeton GitHub", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, visible: 4 },
  { kind: "github_token", label: "jeton GitHub", regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, visible: 11 },
  {
    kind: "jwt",
    label: "jeton JWT",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    visible: 3,
  },
  {
    kind: "connection_string",
    label: "mot de passe dans une URL de connexion",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:[^\s@/"'`]{3,}@[^\s"'`]*/gi,
    visible: 0,
  },
  { kind: "api_key", label: "clé d'API", regex: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g, visible: 3 },
  { kind: "slack_token", label: "jeton Slack", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, visible: 5 },
  { kind: "google_api_key", label: "clé Google", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, visible: 4 },
  { kind: "stripe_key", label: "clé Stripe", regex: /\b[rs]k_(?:live|test)_[0-9a-zA-Z]{16,}\b/g, visible: 8 },
  { kind: "bearer_token", label: "jeton d'autorisation", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, visible: 7 },
];

export interface SecretFinding {
  kind: SecretKind;
  label: string;
  /** 1-based. */
  line: number;
  /** 1-based, UTF-16 units. */
  column: number;
  /** Masked: a known prefix at most, never the secret part. */
  preview: string;
}

function preview(match: string, pattern: SecretPattern): string {
  if (pattern.kind === "connection_string") {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(match)?.[0] ?? "";
    return `${scheme}…:…@…`;
  }
  return `${match.slice(0, pattern.visible)}…`;
}

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
      found.push({
        offset,
        finding: { kind: pattern.kind, label: pattern.label, ...position(starts, offset), preview: preview(match[0], pattern) },
      });
      if (found.length >= maxFindings * 2) break;
    }
  }
  return found
    .sort((a, b) => a.offset - b.offset)
    .slice(0, maxFindings)
    .map((entry) => entry.finding);
}

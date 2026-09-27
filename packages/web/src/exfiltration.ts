// Anti-exfiltration guard (W5 §4) for OUTGOING URLs and bodies (fetch_page URLs, webhooks, remote
// MCP calls). It is a heuristic, announced as such: it catches secrets with known shapes, secrets
// the caller knows literally, and large verbatim chunks of workspace content — not every leak.
import { redactSecrets } from "@nova/shared";

export type ExfiltrationFindingKind = "secret" | "known_secret" | "workspace_content";

export interface ExfiltrationFinding {
  kind: ExfiltrationFindingKind;
  /** Pattern name or matched-content size; never the secret itself. */
  detail: string;
}

export interface OutgoingInspection {
  blocked: boolean;
  findings: ExfiltrationFinding[];
  /** French explanation for the approval card / tool result; null when not blocked. */
  explanation: string | null;
}

export interface OutgoingRequest {
  url: string;
  body?: string | null;
  /** Literal secrets known to main (API keys in use); compared, never logged. */
  knownSecrets?: readonly string[];
  /** Workspace texts that entered the context (file reads…), to detect verbatim copies. */
  workspaceTexts?: readonly string[];
}

// Shapes beyond redactSecrets (which covers sk-… keys and Bearer tokens).
const SECRET_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "clé AWS", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jeton GitHub", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "jeton Slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "clé Google", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "clé Stripe", pattern: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "clé privée", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jeton JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "mot de passe dans une URL de connexion", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{3,}@/i },
];

/** Workspace lines shorter than this are too common (`}`, `import x from "y";`) to prove a copy. */
const MIN_LINE_CHARS = 24;
/** Blocked when this many workspace characters are found verbatim in the outgoing text… */
const MAX_COPIED_CHARS = 400;
/** …or this many distinct workspace lines. */
const MAX_COPIED_LINES = 4;
/** Bound on the work done over workspace texts. */
const MAX_WORKSPACE_CHARS = 2_000_000;

function safeDecode(text: string): string {
  let current = text;
  // Up to two rounds: catches double-encoded payloads without looping on hostile input.
  for (let round = 0; round < 2; round += 1) {
    try {
      const decoded = decodeURIComponent(current.replace(/\+/g, " "));
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function isTextChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return false;
  return code !== 0xfffd;
}

function base64Decodings(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{40,}={0,2}/g)) {
    const decoded = Buffer.from(match[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    // Keep only decodings that look like text (no control characters, no U+FFFD from binary).
    if ([...decoded].every(isTextChar)) out.push(decoded);
  }
  return out;
}

const normalizeLine = (line: string): string => line.replace(/\s+/g, " ").trim();

function workspaceCopy(outgoing: string, workspaceTexts: readonly string[]): { lines: number; chars: number } {
  const lines = new Set<string>();
  let budget = MAX_WORKSPACE_CHARS;
  for (const text of workspaceTexts) {
    if (budget <= 0) break;
    const slice = text.slice(0, budget);
    budget -= slice.length;
    for (const line of slice.split(/\r?\n/)) {
      const normalized = normalizeLine(line);
      if (normalized.length >= MIN_LINE_CHARS) lines.add(normalized);
    }
  }
  if (lines.size === 0) return { lines: 0, chars: 0 };
  const haystack = normalizeLine(outgoing.replace(/\r?\n/g, " "));
  let count = 0;
  let chars = 0;
  for (const line of lines) {
    if (haystack.includes(line)) {
      count += 1;
      chars += line.length;
    }
  }
  return { lines: count, chars };
}

/** Inspects an outgoing request; `blocked` when any finding is present. */
export function inspectOutgoing(request: OutgoingRequest): OutgoingInspection {
  const raw = `${request.url}\n${request.body ?? ""}`;
  const decoded = safeDecode(raw);
  const candidates = [raw, decoded, ...base64Decodings(decoded)];
  const findings: ExfiltrationFinding[] = [];

  if (candidates.some((text) => redactSecrets(text) !== text)) findings.push({ kind: "secret", detail: "clé d'API" });
  for (const { name, pattern } of SECRET_SHAPES) {
    if (candidates.some((text) => pattern.test(text))) findings.push({ kind: "secret", detail: name });
  }
  const known = (request.knownSecrets ?? []).filter((secret) => secret.length >= 8);
  if (known.some((secret) => candidates.some((text) => text.includes(secret)))) {
    findings.push({ kind: "known_secret", detail: "secret enregistré dans NOVA" });
  }
  if (request.workspaceTexts && request.workspaceTexts.length > 0) {
    const copy = workspaceCopy(candidates.join("\n"), request.workspaceTexts);
    if (copy.chars >= MAX_COPIED_CHARS || copy.lines >= MAX_COPIED_LINES) {
      findings.push({ kind: "workspace_content", detail: `${copy.lines} lignes (${copy.chars} caractères) de ton projet` });
    }
  }

  if (findings.length === 0) return { blocked: false, findings, explanation: null };
  const what = [...new Set(findings.map((finding) => finding.detail))].join(", ");
  return {
    blocked: true,
    findings,
    explanation: `NOVA a bloqué cette requête : elle semble contenir ${what}. Rien n'a été envoyé. Cette vérification est une heuristique ; si c'est voulu, reformule la demande sans ces données.`,
  };
}

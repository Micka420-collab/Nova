// Secret redaction applied to anything that may reach logs, error details, exports or the UI.
import { SECRET_PATTERNS } from "./sensitive";

// Generic shapes (any `sk-…` key, any bearer token) plus the canonical C8 shapes (./sensitive).
const GENERIC_PATTERNS: RegExp[] = [
  // Whole PEM private key blocks (the C8 pattern only marks their header).
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // OpenRouter keys (sk-or-v1-…) and generic sk- style API keys.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
];
// Authorization headers and bearer tokens: the scheme word is kept.
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const REDACTED = "[secret masqué]";

/** Replace every known secret shape in `text`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of GENERIC_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(BEARER, (_match, bearer: string) => `${bearer} ${REDACTED}`);
  for (const { regex } of SECRET_PATTERNS) out = out.replace(regex, REDACTED);
  return out;
}

/** Redact and bound a provider-supplied message before storing or displaying it. */
export function sanitizeProviderMessage(text: string | null | undefined, max = 500): string | null {
  if (typeof text !== "string") return null;
  const trimmed = redactSecrets(text).trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Only the last 4 characters of a key may ever be shown. */
export function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

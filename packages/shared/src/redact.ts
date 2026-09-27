// Secret redaction applied to anything that may reach logs, error details, exports or the UI.

const SECRET_PATTERNS: RegExp[] = [
  // OpenRouter keys (sk-or-v1-…) and generic sk- style API keys.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Authorization headers and bearer tokens.
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

const REDACTED = "[secret masqué]";

/** Replace every known secret shape in `text`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, bearer?: string) =>
      typeof bearer === "string" && /^bearer$/i.test(bearer) ? `${bearer} ${REDACTED}` : REDACTED,
    );
  }
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

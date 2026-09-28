// Typed refusals and failures of the web layer. `message` is developer-facing English; the UI and
// the model-facing tool text are chosen from `code` (French copy lives with the callers).

export type WebErrorCode =
  /** Not an http(s) URL, credentials in the URL, unparsable. */
  | "invalid_url"
  /** SSRF guard: private, loopback, link-local, metadata or otherwise non-public destination. */
  | "blocked_address"
  /** Domain policy (or mission contract) refuses the host. */
  | "policy_denied"
  /** Domain policy asks before reaching this host (e.g. a redirect to a host not yet approved). */
  | "policy_ask"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "aborted"
  | "unsupported_content_type"
  /** Non-2xx HTTP status from the destination. */
  | "http_error"
  | "network"
  /** Anti-exfiltration heuristic found secrets or workspace content in an outgoing request (W5). */
  | "exfiltration_blocked"
  /** No usable model / key / response for web search. */
  | "search_unavailable"
  | "search_failed";

export class WebError extends Error {
  readonly code: WebErrorCode;
  /** Host concerned by the refusal, when meaningful (lowercase). */
  readonly host: string | null;
  /** HTTP status for `http_error`. */
  readonly status: number | null;
  /** French, user-facing explanation when the refusal needs one (exfiltration guard). */
  readonly explanation: string | null;

  constructor(
    code: WebErrorCode,
    message: string,
    details: { host?: string | null; status?: number | null; explanation?: string | null } = {},
  ) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.host = details.host ?? null;
    this.status = details.status ?? null;
    this.explanation = details.explanation ?? null;
  }
}

export function isWebError(error: unknown): error is WebError {
  return error instanceof WebError;
}

const SAFE_TOKEN = /^[a-z0-9.+/-]{1,40}$/;

/**
 * A server-controlled value (header, URL scheme) as it may appear in a WebError message. Those
 * messages reach the model as trusted tool-failure text, never fenced: anything beyond a short
 * protocol token is dropped so a hostile server cannot speak through an error.
 */
export function safeWireToken(raw: string | undefined): string {
  const token = (raw ?? "").trim().toLowerCase();
  return SAFE_TOKEN.test(token) ? token : "(unrecognized)";
}

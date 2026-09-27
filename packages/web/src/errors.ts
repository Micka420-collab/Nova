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

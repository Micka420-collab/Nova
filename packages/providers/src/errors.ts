// Mapping of OpenRouter failures (HTTP errors, mid-stream error chunks) to ProviderErrorInfo.
import { sanitizeProviderMessage, type ProviderErrorCode, type ProviderErrorInfo } from "@nova/shared";
import { asRecord, asString, asStringArray, type JsonRecord } from "./coerce";

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "timeout",
  "rate_limited",
  "model_unavailable",
  "no_provider",
  "provider_error",
  "network",
  "stream_interrupted",
  // Generation outcomes (finish_reason): a new attempt can finish; a filter verdict will not change.
  "truncated",
  "empty_response",
]);

const STATUS_CODES: Readonly<Partial<Record<number, ProviderErrorCode>>> = {
  400: "bad_request",
  401: "invalid_key",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  408: "timeout",
  429: "rate_limited",
  502: "model_unavailable",
  503: "no_provider",
};

export interface ProviderErrorDetails {
  httpStatus?: number | null;
  retryAfterSec?: number | null;
  providerMessage?: string | null;
}

/** Builds an error info; `retryable` is derived from the code so it cannot drift. */
export function providerErrorInfo(code: ProviderErrorCode, details: ProviderErrorDetails = {}): ProviderErrorInfo {
  return {
    code,
    httpStatus: details.httpStatus ?? null,
    retryAfterSec: details.retryAfterSec ?? null,
    providerMessage: details.providerMessage ?? null,
    retryable: RETRYABLE_CODES.has(code),
  };
}

function codeForStatus(status: number): ProviderErrorCode {
  return STATUS_CODES[status] ?? (status >= 500 && status <= 599 ? "provider_error" : "unknown");
}

/** Retry-After as delay-seconds or HTTP-date, converted to whole seconds from `now`. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed));
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

/** OpenRouter's `limit_source` for too many concurrent generations: a wait, not an empty balance. */
const IN_FLIGHT_BUDGET = "openrouter_in_flight_budget";

/** Provider message plus the machine-readable kind and moderation reasons when present. */
function describeError(error: JsonRecord): string | null {
  const metadata = asRecord(error.metadata);
  const code = typeof error.code === "string" && !/^\d+$/.test(error.code) ? error.code : null;
  const kind = code ?? asString(metadata?.error_type);
  const reasons = asStringArray(metadata?.reasons) ?? [];
  const parts = [
    asString(error.message),
    kind === null ? null : `(${kind})`,
    reasons.length > 0 ? `motifs : ${reasons.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return sanitizeProviderMessage(parts.join(" "));
}

function parseBody(bodyText: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(bodyText));
  } catch {
    return null;
  }
}

function describeBody(bodyText: string, root: JsonRecord | null): string | null {
  // Non-JSON bodies (proxies, gateways) are kept as detail unless they are HTML pages.
  if (!root) return bodyText.trimStart().startsWith("<") ? null : sanitizeProviderMessage(bodyText);
  const error = asRecord(root.error);
  if (error) return describeError(error);
  return sanitizeProviderMessage(asString(root.message) ?? asString(root.error));
}

/**
 * A 402 is an empty balance, except OpenRouter's in-flight budget (documented to carry
 * Retry-After): that one clears by waiting, so it is a rate limit with its countdown.
 */
function codeForResponse(status: number, root: JsonRecord | null, retryAfterSec: number | null): ProviderErrorCode {
  if (status !== 402) return codeForStatus(status);
  const limitSource = asString(asRecord(asRecord(root?.error)?.metadata)?.limit_source);
  return limitSource === IN_FLIGHT_BUDGET || retryAfterSec !== null ? "rate_limited" : "insufficient_credits";
}

/** Maps a non-2xx HTTP response. `bodyText` must already be free of the caller's key. */
export function mapHttpError(
  status: number,
  bodyText: string,
  headers: Headers,
  now: number = Date.now(),
): ProviderErrorInfo {
  const root = parseBody(bodyText);
  const retryAfterSec = parseRetryAfter(headers.get("retry-after"), now);
  return providerErrorInfo(codeForResponse(status, root, retryAfterSec), {
    httpStatus: status,
    retryAfterSec,
    providerMessage: describeBody(bodyText, root),
  });
}

/**
 * Maps the `error` object of a mid-stream SSE chunk (sent after HTTP 200).
 * A numeric (or numeric string) code is HTTP-like and reported as `httpStatus`.
 */
export function mapStreamError(errorObject: unknown): ProviderErrorInfo {
  const error = asRecord(errorObject);
  const rawCode = error?.code;
  const status =
    typeof rawCode === "number" && Number.isInteger(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^\d{3}$/.test(rawCode)
        ? Number(rawCode)
        : null;
  return providerErrorInfo(status === null ? "provider_error" : codeForStatus(status), {
    httpStatus: status,
    providerMessage: error ? describeError(error) : sanitizeProviderMessage(asString(errorObject)),
  });
}

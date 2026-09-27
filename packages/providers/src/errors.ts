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

function describeBody(bodyText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Non-JSON bodies (proxies, gateways) are kept as detail unless they are HTML pages.
    return bodyText.trimStart().startsWith("<") ? null : sanitizeProviderMessage(bodyText);
  }
  const root = asRecord(parsed);
  const error = asRecord(root?.error);
  if (error) return describeError(error);
  return sanitizeProviderMessage(asString(root?.message) ?? asString(root?.error));
}

/** Maps a non-2xx HTTP response. `bodyText` must already be free of the caller's key. */
export function mapHttpError(
  status: number,
  bodyText: string,
  headers: Headers,
  now: number = Date.now(),
): ProviderErrorInfo {
  return providerErrorInfo(codeForStatus(status), {
    httpStatus: status,
    retryAfterSec: parseRetryAfter(headers.get("retry-after"), now),
    providerMessage: describeBody(bodyText),
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

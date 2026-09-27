// Turns IPC/provider failures into the French copy shown to the user. Never exposes raw exceptions.
import { NovaIpcError, redactSecrets, type IpcErrorCode, type ProviderErrorInfo } from "@nova/shared";
import { IPC_ERROR_COPY, PROVIDER_ERROR_COPY, rateLimitedTitle, type ErrorCopy } from "../copy/fr";

export interface UiError {
  code: IpcErrorCode;
  providerError: ProviderErrorInfo | null;
}

export function toUiError(error: unknown): UiError {
  if (error instanceof NovaIpcError) return { code: error.code, providerError: error.providerError ?? null };
  // Anything else is a renderer bug; the message is logged (redacted), the user sees the generic copy.
  console.error("unexpected renderer error", redactSecrets(error instanceof Error ? error.message : String(error)));
  return { code: "internal", providerError: null };
}

export function describeProviderError(info: ProviderErrorInfo): ErrorCopy {
  const copy = PROVIDER_ERROR_COPY[info.code];
  if (info.code === "rate_limited" && info.retryAfterSec !== null) {
    return { ...copy, title: rateLimitedTitle(info.retryAfterSec) };
  }
  return copy;
}

export function describeUiError(error: UiError): ErrorCopy {
  if (error.providerError) return describeProviderError(error.providerError);
  return { title: IPC_ERROR_COPY[error.code], detail: "", action: null };
}

/** Title and optional description, ready for a toast. */
export function errorToast(error: unknown, title: string): { title: string; description: string; tone: "danger" } {
  const copy = describeUiError(toUiError(error));
  return { title, description: copy.detail ? `${copy.title}. ${copy.detail}` : copy.title, tone: "danger" };
}

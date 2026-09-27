// Follow-up action offered for each provider error (retry is handled by the caller).
import { useToast } from "@nova/ui";
import type { ProviderErrorCode } from "@nova/shared";
import { PROVIDER_ERROR_COPY } from "../copy/fr";
import { errorToast } from "../lib/errors";
import { OPENROUTER_CREDITS_URL } from "../lib/links";
import { useApp, useClient } from "../state/context";

export type ErrorActionKind = "retry" | "providers" | "credits" | "model" | "privacy";

export const ERROR_ACTIONS: Record<ProviderErrorCode, ErrorActionKind> = {
  no_key: "providers",
  invalid_key: "providers",
  insufficient_credits: "credits",
  forbidden: "model",
  rate_limited: "retry",
  timeout: "retry",
  not_found: "model",
  model_unavailable: "model",
  no_provider: "privacy",
  bad_request: "model",
  network: "retry",
  stream_interrupted: "retry",
  provider_error: "retry",
  aborted: "retry",
  unknown: "retry",
};

/** Label and handler of the non-retry action for `code`, or null when retrying is the only step. */
export function useErrorAction(code: ProviderErrorCode): { label: string; run: () => void } | null {
  const client = useClient();
  const toast = useToast();
  const openSettings = useApp((state) => state.openSettings);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const kind = ERROR_ACTIONS[code];
  const label = PROVIDER_ERROR_COPY[code].action;
  if (kind === "retry" || label === null) return null;
  const run = () => {
    if (kind === "providers") openSettings("providers");
    else if (kind === "privacy") openSettings("privacy");
    else if (kind === "model") openModelPicker("conversation");
    else {
      client.app.openExternal({ url: OPENROUTER_CREDITS_URL }).catch((error: unknown) => {
        toast.show(errorToast(error, label));
      });
    }
  };
  return { label, run };
}

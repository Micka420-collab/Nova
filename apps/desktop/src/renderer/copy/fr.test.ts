import { describe, expect, it } from "vitest";
import type { IpcErrorCode, ProviderErrorCode } from "@nova/shared";
import { describeProviderError } from "../lib/errors";
import { IPC_ERROR_COPY, PROVIDER_ERROR_COPY, VAULT_LEVEL_COPY } from "./fr";

// Exhaustive lists: adding a code to the shared contract without listing it here fails to compile.
const PROVIDER_CODES = [
  "no_key",
  "invalid_key",
  "insufficient_credits",
  "forbidden",
  "rate_limited",
  "timeout",
  "not_found",
  "model_unavailable",
  "no_provider",
  "bad_request",
  "network",
  "stream_interrupted",
  "provider_error",
  "aborted",
  "truncated",
  "filtered",
  "empty_response",
  "key_unreadable",
  "unknown",
] as const satisfies readonly ProviderErrorCode[];
const IPC_CODES = [
  "invalid_request",
  "not_found",
  "conflict",
  "vault_unavailable",
  "no_key",
  "key_unreadable",
  "provider",
  "internal",
] as const satisfies readonly IpcErrorCode[];

type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : false;
const providerListComplete: Missing<ProviderErrorCode, (typeof PROVIDER_CODES)[number]> = true;
const ipcListComplete: Missing<IpcErrorCode, (typeof IPC_CODES)[number]> = true;

describe("French error copy", () => {
  it("covers every provider error code with a title and an explanation", () => {
    expect(providerListComplete).toBe(true);
    expect(Object.keys(PROVIDER_ERROR_COPY).sort()).toEqual([...PROVIDER_CODES].sort());
    const incomplete = PROVIDER_CODES.filter(
      (code) => !PROVIDER_ERROR_COPY[code].title.trim() || !PROVIDER_ERROR_COPY[code].detail.trim(),
    );
    expect(incomplete).toEqual([]);
  });

  it("covers every IPC error code", () => {
    expect(ipcListComplete).toBe(true);
    expect(Object.keys(IPC_ERROR_COPY).sort()).toEqual([...IPC_CODES].sort());
    expect(IPC_CODES.filter((code) => !IPC_ERROR_COPY[code].trim())).toEqual([]);
  });

  it("uses the agreed wording for the main failures", () => {
    expect(PROVIDER_ERROR_COPY.invalid_key.title).toBe("La clé OpenRouter est refusée");
    expect(PROVIDER_ERROR_COPY.insufficient_credits.title).toBe("Crédits OpenRouter insuffisants");
    expect(PROVIDER_ERROR_COPY.timeout.title).toBe("Le modèle ne répond pas");
    expect(PROVIDER_ERROR_COPY.network.title).toBe("Pas de connexion au fournisseur");
    expect(PROVIDER_ERROR_COPY.stream_interrupted.title).toBe("La réponse a été coupée en route");
    expect(PROVIDER_ERROR_COPY.aborted.title).toBe("Génération arrêtée");
    expect(PROVIDER_ERROR_COPY.not_found.detail).toMatch(/Confidentialité/);
  });

  it("presents no_provider as an availability problem, not as the user's privacy setting", () => {
    // A 503 is usually an outage: the data policy is only a secondary hint (see mentionsDataPolicy).
    expect(PROVIDER_ERROR_COPY.no_provider.detail).toMatch(/pour l'instant/);
    expect(PROVIDER_ERROR_COPY.no_provider.detail).not.toMatch(/Confidentialité|conservation/);
    expect(PROVIDER_ERROR_COPY.no_provider.action).toBe("Changer de modèle");
  });

  it("describes the vault as a capability, not as a fact about a key that may be a session key or absent", () => {
    expect(VAULT_LEVEL_COPY.os.detail).toMatch(/^Les clés enregistrées dans le coffre sont chiffrées/);
    expect(VAULT_LEVEL_COPY.unavailable.detail).not.toMatch(/^NOVA ne peut pas chiffrer la clé/);
  });

  it("puts the provider's Retry-After delay in the rate limit title", () => {
    const info = { code: "rate_limited", httpStatus: 429, retryAfterSec: 7, providerMessage: null, retryable: true } as const;
    expect(describeProviderError(info).title).toBe("Trop de requêtes — réessaie dans 7 s");
    expect(describeProviderError({ ...info, retryAfterSec: null }).title).toBe("Trop de requêtes");
  });
});

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConnectionView, ProviderErrorInfo } from "@nova/shared";
import { VALID_CONNECTION } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { renderApp } from "../../test/render-app";

installDomPolyfills();
afterEach(cleanup);

function unverified(code: ProviderErrorInfo["code"]): ProviderConnectionView {
  return {
    ...VALID_CONNECTION,
    state: "unverified",
    check: null,
    lastCheckedAt: null,
    lastError: { code, httpStatus: null, retryAfterSec: null, providerMessage: null, retryable: true },
  };
}

async function saveKey(result: ProviderConnectionView) {
  const app = renderApp({ setKeyResult: result });
  fireEvent.change(await screen.findByLabelText("Clé API OpenRouter"), { target: { value: "sk-or-v1-test-key-1234" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Tester et enregistrer" }));
  });
  return app;
}

describe("saving a key that could not be verified", () => {
  it.each([
    ["network", /OpenRouter est injoignable/],
    ["timeout", /OpenRouter est injoignable/],
    ["rate_limited", /trop de requêtes/],
    ["provider_error", /Le service OpenRouter a renvoyé une erreur/],
  ] as const)("%s: says what really happened, without promising an automatic retry", async (code, reason) => {
    await saveKey(unverified(code));
    const callout = screen.getByText("Clé enregistrée, mais pas encore vérifiée").closest(".nv-callout") as HTMLElement;
    expect(callout.textContent).toMatch(reason);
    expect(callout.textContent).not.toMatch(/réessaiera|n'a pas pu être joint/);
  });

  it("offers to test the key again from the same place", async () => {
    const { calls, setConnection } = await saveKey(unverified("network"));
    setConnection({ ...VALID_CONNECTION });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tester la clé" }));
    });
    expect(calls).toContain("connection.test");
    expect(screen.getByText("Clé vérifiée")).toBeTruthy();
  });
});

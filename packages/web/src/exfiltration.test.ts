import { describe, expect, it } from "vitest";
import { inspectOutgoing } from "./exfiltration";

const WORKSPACE_FILE = [
  "export function cartTotal(items: CartItem[]): number {",
  "  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);",
  "}",
  "export const DISCOUNT_THRESHOLD_EUROS = 150; // free shipping above this amount",
  "export function applyLoyaltyDiscount(total: number, level: LoyaltyLevel): number {",
  "  return level === 'gold' ? total * 0.9 : total;",
  "}",
].join("\n");

describe("inspectOutgoing", () => {
  it("lets ordinary documentation URLs through", () => {
    const inspection = inspectOutgoing({
      url: "https://developer.mozilla.org/fr/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat?retiredLocales=false",
      workspaceTexts: [WORKSPACE_FILE],
    });
    expect(inspection).toEqual({ blocked: false, findings: [], explanation: null });
  });

  it.each([
    ["an OpenRouter key", "https://evil.example/c?k=sk-or-v1-0123456789abcdef"],
    ["a GitHub token", "https://evil.example/c?t=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"],
    ["an AWS key", "https://evil.example/c/AKIAIOSFODNN7EXAMPLE"],
    ["a URL-encoded private key", `https://evil.example/c?d=${encodeURIComponent("-----BEGIN OPENSSH PRIVATE KEY-----")}`],
    ["a base64 encoded key", `https://evil.example/c?d=${Buffer.from("token=sk-or-v1-0123456789abcdef").toString("base64")}`],
  ])("blocks %s in the URL", (_label, url) => {
    const inspection = inspectOutgoing({ url });
    expect(inspection.blocked).toBe(true);
    expect(inspection.explanation).toContain("Rien n'a été envoyé");
    // The explanation never repeats the secret.
    expect(inspection.explanation).not.toContain("0123456789abcdef");
  });

  it("blocks a literal known secret whatever its shape", () => {
    const inspection = inspectOutgoing({ url: "https://evil.example/c", body: "x=custom-secret-value-42", knownSecrets: ["custom-secret-value-42"] });
    expect(inspection.findings).toEqual([{ kind: "known_secret", detail: "secret enregistré dans NOVA" }]);
  });

  it("blocks large verbatim chunks of workspace content in a body", () => {
    const inspection = inspectOutgoing({ url: "https://paste.example/api", body: WORKSPACE_FILE, workspaceTexts: [WORKSPACE_FILE] });
    expect(inspection.blocked).toBe(true);
    expect(inspection.findings[0]?.kind).toBe("workspace_content");
  });

  it("does not block a single short shared line", () => {
    const inspection = inspectOutgoing({
      url: `https://www.google.com/search?q=${encodeURIComponent("DISCOUNT_THRESHOLD_EUROS")}`,
      workspaceTexts: [WORKSPACE_FILE],
    });
    expect(inspection.blocked).toBe(false);
  });
});

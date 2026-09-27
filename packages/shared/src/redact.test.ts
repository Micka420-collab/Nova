import { describe, expect, it } from "vitest";
import { keyHint, redactSecrets, sanitizeProviderMessage } from "./redact";

describe("redactSecrets", () => {
  it("masks OpenRouter keys and bearer tokens wherever they appear", () => {
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const text = `key=${key} header="Authorization: Bearer ${key}"`;
    const out = redactSecrets(text);
    expect(out).not.toContain("0123456789abcdef");
    expect(out).toContain("Bearer [secret masqué]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("Le modèle ne répond pas (502).")).toBe("Le modèle ne répond pas (502).");
  });
});

describe("sanitizeProviderMessage", () => {
  it("bounds length and returns null for empty input", () => {
    expect(sanitizeProviderMessage("   ")).toBeNull();
    expect(sanitizeProviderMessage(undefined)).toBeNull();
    expect(sanitizeProviderMessage("x".repeat(600))?.length).toBe(501);
  });
});

describe("keyHint", () => {
  it("never exposes more than 4 characters", () => {
    expect(keyHint("sk-or-v1-abcdefgh")).toBe("efgh");
  });
});

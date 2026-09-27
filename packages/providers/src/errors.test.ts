import type { ProviderErrorCode } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { mapHttpError, mapStreamError, parseRetryAfter } from "./errors";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function body(code: number, message: string, metadata?: unknown): string {
  return JSON.stringify({ error: { code, message, ...(metadata === undefined ? {} : { metadata }) } });
}

describe("mapHttpError", () => {
  it.each<[number, ProviderErrorCode, boolean]>([
    [400, "bad_request", false],
    [401, "invalid_key", false],
    [402, "insufficient_credits", false],
    [403, "forbidden", false],
    [404, "not_found", false],
    [408, "timeout", true],
    [429, "rate_limited", true],
    [500, "provider_error", true],
    [502, "model_unavailable", true],
    [503, "no_provider", true],
    [504, "provider_error", true],
    [418, "unknown", false],
  ])("maps HTTP %i to %s (retryable: %s)", (status, code, retryable) => {
    const info = mapHttpError(status, body(status, "Détail fournisseur"), new Headers(), NOW);
    expect(info).toEqual({ code, httpStatus: status, retryAfterSec: null, providerMessage: "Détail fournisseur", retryable });
  });

  it("reads Retry-After as seconds or HTTP-date", () => {
    const seconds = mapHttpError(429, body(429, "Rate limited"), new Headers({ "Retry-After": "7" }), NOW);
    expect(seconds.retryAfterSec).toBe(7);
    const date = new Headers({ "Retry-After": new Date(NOW + 90_500).toUTCString() });
    expect(mapHttpError(429, body(429, "Rate limited"), date, NOW).retryAfterSec).toBe(90);
  });

  it("maps the in-flight budget 402 to a rate limit with its Retry-After, not to missing credits", () => {
    const inFlight = body(402, "Too many concurrent requests", { limit_source: "openrouter_in_flight_budget" });
    expect(mapHttpError(402, inFlight, new Headers({ "Retry-After": "4" }), NOW)).toMatchObject({
      code: "rate_limited",
      httpStatus: 402,
      retryAfterSec: 4,
      retryable: true,
    });
    expect(mapHttpError(402, inFlight, new Headers(), NOW)).toMatchObject({ code: "rate_limited", retryAfterSec: null });
    const withHeader = mapHttpError(402, body(402, "Wait"), new Headers({ "Retry-After": "2" }), NOW);
    expect(withHeader).toMatchObject({ code: "rate_limited", retryAfterSec: 2 });
    const creditsBody = body(402, "Insufficient credits", { limit_source: "account" });
    const credits = mapHttpError(402, creditsBody, new Headers(), NOW);
    expect(credits).toMatchObject({ code: "insufficient_credits", retryable: false });
  });

  it("includes moderation reasons from a 403", () => {
    const info = mapHttpError(
      403,
      body(403, "Input was flagged", { reasons: ["violence", "harassment"], flagged_input: "…" }),
      new Headers(),
      NOW,
    );
    expect(info.providerMessage).toBe("Input was flagged motifs : violence, harassment");
  });

  it("keeps plain-text bodies, drops HTML pages and redacts secrets", () => {
    expect(mapHttpError(502, "upstream reset", new Headers()).providerMessage).toBe("upstream reset");
    expect(mapHttpError(502, "<html><body>Bad gateway</body></html>", new Headers()).providerMessage).toBeNull();
    const leaked = mapHttpError(401, body(401, "bad key sk-or-v1-0123456789abcdef"), new Headers());
    expect(leaked.providerMessage).not.toContain("0123456789abcdef");
  });
});

describe("parseRetryAfter", () => {
  it("returns null for absent or unparsable values and never a negative delay", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter("1.2", NOW)).toBe(2);
  });
});

describe("mapStreamError", () => {
  it("maps numeric codes like HTTP statuses", () => {
    expect(mapStreamError({ code: 502, message: "Provider disconnected" })).toEqual({
      code: "model_unavailable",
      httpStatus: 502,
      retryAfterSec: null,
      providerMessage: "Provider disconnected",
      retryable: true,
    });
    expect(mapStreamError({ code: "429", message: "Slow down" }).code).toBe("rate_limited");
  });

  it("treats string codes as provider errors and keeps the kind as detail", () => {
    const info = mapStreamError({ code: "server_error", message: "Provider disconnected unexpectedly" });
    expect(info).toMatchObject({ code: "provider_error", httpStatus: null, retryable: true });
    expect(info.providerMessage).toBe("Provider disconnected unexpectedly (server_error)");
    expect(mapStreamError({ code: 400, message: "x", metadata: { error_type: "context_length" } }).providerMessage).toBe(
      "x (context_length)",
    );
  });

  it("survives malformed error objects", () => {
    expect(mapStreamError(null)).toMatchObject({ code: "provider_error", providerMessage: null });
    expect(mapStreamError("boom")).toMatchObject({ code: "provider_error", providerMessage: "boom" });
  });
});

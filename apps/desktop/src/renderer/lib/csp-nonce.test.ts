import { describe, expect, it } from "vitest";
import { readStyleNonce } from "./csp-nonce";

describe("readStyleNonce", () => {
  it("reads the nonce injected by main and ignores malformed values", () => {
    const doc = (content: string | null) => {
      const html = document.implementation.createHTMLDocument("t");
      if (content !== null) {
        const meta = html.createElement("meta");
        meta.name = "nova-style-nonce";
        meta.content = content;
        html.head.append(meta);
      }
      return html;
    };
    expect(readStyleNonce(doc("q1w2e3r4t5y6u7i8o9p0aA=="))).toBe("q1w2e3r4t5y6u7i8o9p0aA==");
    expect(readStyleNonce(doc(null))).toBeNull();
    expect(readStyleNonce(doc("x' 'unsafe-inline"))).toBeNull();
  });
});

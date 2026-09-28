import { describe, expect, it } from "vitest";
import { Scrollback } from "./scrollback";

describe("Scrollback.plainTail", () => {
  it("drops colors, cursor moves and titles, normalizes line ends, and keeps only the end", () => {
    const scrollback = new Scrollback(10_000);
    scrollback.push("\u001b]0;pnpm test\u0007\u001b[1m\u001b[32m ✓ \u001b[39m\u001b[22mcart.test.ts (2)\r\n");
    scrollback.push("\u001b[2K\u001b[1GTests  2 passed (2)\r\n");
    expect(scrollback.plainTail(1_000)).toBe(" ✓ cart.test.ts (2)\nTests  2 passed (2)\n");
    expect(scrollback.plainTail(10)).toBe("passed (2)\n".slice(-10));
  });
});

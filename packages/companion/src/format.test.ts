import { describe, expect, it } from "vitest";
import { formatUsd } from "./format";

describe("formatUsd", () => {
  it("keeps amounts under one cent readable instead of « 0,00 $ » (a 0,002 $ cap)", () => {
    expect(formatUsd(0.0016)).toBe("0,0016 $");
    expect(formatUsd(0.002)).toBe("0,002 $");
    expect(formatUsd(0)).toBe("0,00 $");
    expect(formatUsd(0.5)).toBe("0,50 $");
    expect(formatUsd(1.234, true)).toBe("au moins 1,23 $");
  });
});

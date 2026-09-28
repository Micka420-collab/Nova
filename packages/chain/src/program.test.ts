import { describe, expect, it } from "vitest";
import { chainProgramPreview, checkChainProgram } from "./program";

describe("checkChainProgram", () => {
  it("accepts an async body using nova", () => {
    expect(checkChainProgram("const a = await nova.read_file({ path: 'a.ts' });\nreturn a.length;")).toEqual({ ok: true });
  });

  it.each([
    ["dynamic import", "const fs = await import('node:fs');"],
    ["import.meta", "return import.meta.url;"],
    ["a static import", "import fs from 'node:fs';\nreturn 1;"],
    ["an export", "export const a = 1;"],
  ])("refuses %s", (_what, program) => {
    expect(checkChainProgram(program)).toMatchObject({ ok: false, reason: "forbidden_syntax" });
  });

  it("refuses an empty or unparsable program with a reason", () => {
    expect(checkChainProgram("  \n")).toEqual({ ok: false, reason: "syntax", detail: "the program is empty" });
    expect(checkChainProgram("const = 1;")).toMatchObject({ ok: false, reason: "syntax", detail: expect.stringContaining("syntax error") });
  });

  it("refuses a program over the size limit", () => {
    expect(checkChainProgram("x;".repeat(20), 10)).toMatchObject({ ok: false, reason: "too_large" });
  });
});

describe("chainProgramPreview", () => {
  it("redacts secrets and caps the preview at 2 000 characters", () => {
    const preview = chainProgramPreview(`const key = "sk-or-v1-0123456789abcdef0123456789abcdef";\n${"x".repeat(5_000)}`);
    expect(preview).not.toContain("sk-or-v1-0123456789abcdef");
    expect(preview.length).toBeLessThanOrEqual(2_000);
  });
});

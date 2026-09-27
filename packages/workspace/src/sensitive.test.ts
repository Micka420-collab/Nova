import { describe, expect, it } from "vitest";
import { checkOutgoingContent, redactSensitive, scanForSecrets } from "./sensitive";

const token = (prefix: string, length: number, char = "A"): string => prefix + char.repeat(length);

describe("secret scan (C8)", () => {
  it("finds each supported secret shape with its position and a masked preview", () => {
    const text = [
      "const ok = 'nothing here';",
      `aws = "AKIA${"ABCDEFGHIJKLMNOP"}"`,
      `aws_secret_access_key = ${"a".repeat(40)}`,
      `gh = ${token("ghp_", 36)}`,
      `pat = ${token("github_pat_", 30, "b")}`,
      "jwt = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "DATABASE_URL=postgres://admin:hunter2@db.example.com:5432/app",
      `key = ${token("sk-or-v1-", 30, "x")}`,
    ].join("\n");
    const findings = scanForSecrets(text);
    expect(findings.map((finding) => [finding.kind, finding.line])).toEqual([
      ["aws_access_key", 2],
      ["aws_secret_key", 3],
      ["github_token", 4],
      ["github_token", 5],
      ["jwt", 6],
      ["private_key", 7],
      ["connection_string", 8],
      ["api_key", 9],
    ]);
    expect(findings[0]).toMatchObject({ column: 8, preview: "AKIA…" });
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("does not flag ordinary code", () => {
    const code = "const task_list = ['sk-short'];\nconst url = 'postgres://localhost:5432/app';\nexport const eyJ = 1;\n";
    expect(scanForSecrets(code)).toEqual([]);
  });

  it("blocks excluded paths and secret-bearing content, and redacts for logs", () => {
    expect(checkOutgoingContent({ path: ".env", content: "A=1", isExcluded: (path) => path === ".env" })).toEqual({
      allowed: false,
      reason: "excluded_path",
      path: ".env",
    });
    expect(checkOutgoingContent({ path: "a.ts", content: "fine" })).toEqual({ allowed: true });
    expect(checkOutgoingContent({ path: "a.ts", content: token("ghp_", 36) })).toMatchObject({ allowed: false, reason: "secrets" });
    expect(redactSensitive(`token ${token("ghp_", 36)} and Bearer abcdefghijkl`)).toBe("token [secret masqué] and Bearer [secret masqué]");
  });
});

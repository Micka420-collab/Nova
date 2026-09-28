import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";
import { isSensitivePath, scanForSecrets } from "./sensitive";

describe("isSensitivePath (C8 canonical list)", () => {
  it.each([
    [".env", true],
    ["apps/api/.env.production", true],
    [".env.example", false],
    ["deploy/.env.template", false],
    ["certs/site.pem", true],
    ["home/.ssh", true],
    ["home/.ssh/config", true],
    [".aws/credentials", true],
    ["keys/id_rsa", true],
    ["keys/id_rsa.pub", false],
    [".git/config", true],
    ["node_modules/react/index.js", true],
    ["infra/terraform.tfstate.backup", true],
    ["secrets/service-account-prod.json", true],
    ["src/credentials.ts", false],
    ["src/env.ts", false],
    ["README.md", false],
    ["", false],
  ])("%s → %s", (path, expected) => {
    expect(isSensitivePath(path)).toBe(expected);
  });

  it.each([
    ".ENV",
    "apps/.Env.Production",
    ".Git/hooks/pre-commit",
    "NODE_MODULES/x/index.js",
    "keys/ID_RSA",
    "Credentials.json",
    "certs/server.PEM",
    ".SSH/config",
    ".env::$DATA",
    ".env:secret",
    ".env.",
    ".env ",
    ".git./hooks/pre-commit",
    "certs/site.pem. .",
  ])("matches %j as the OS resolves it (case-insensitive FS, NTFS names)", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([".ENV.Example", "keys/ID_RSA.PUB", "src/Env.ts"])("keeps %j re-included / unrelated", (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it("cannot re-include a file below an excluded folder", () => {
    expect(isSensitivePath(".ssh/id_ed25519.pub")).toBe(true);
  });
});

describe("scanForSecrets / redactSecrets share one list", () => {
  const samples = [
    `AKIA${"ABCDEFGHIJKLMNOP"}`,
    `ghp_${"a".repeat(36)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl",
    "postgres://admin:hunter2@db.example.com/app",
    `xoxb-${"1".repeat(12)}`,
    `AIza${"b".repeat(35)}`,
    `sk_test_${"c".repeat(24)}`,
  ];

  it.each(samples)("every scanned shape is also masked: %s", (secret) => {
    expect(scanForSecrets(`value = ${secret}`)).toHaveLength(1);
    expect(redactSecrets(`value = ${secret}`)).toBe("value = [secret masqué]");
  });

  it("masks a whole PEM private key block, not only its header", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`key:\n${pem}\nnext`)).toBe("key:\n[secret masqué]\nnext");
  });
});

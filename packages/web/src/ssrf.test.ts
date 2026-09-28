import { describe, expect, it } from "vitest";
import { WebError } from "./errors";
import { checkUrlShape, isBlockedAddress, resolvePublicAddresses, type ResolveHost } from "./ssrf";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof WebError ? error.code : "other";
  }
}

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("accepts public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("test override opens loopback only", () => {
    const options = { dangerouslyAllowLoopbackForTests: true };
    expect(isBlockedAddress("127.0.0.1", options)).toBe(false);
    expect(isBlockedAddress("::1", options)).toBe(false);
    expect(isBlockedAddress("10.0.0.1", options)).toBe(true);
    expect(isBlockedAddress("169.254.169.254", options)).toBe(true);
  });
});

describe("checkUrlShape", () => {
  it.each([
    ["file:///etc/passwd", "invalid_url"],
    ["ftp://example.com/x", "invalid_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["https://user:pass@example.com/", "invalid_url"],
    ["https://token@example.com/", "invalid_url"],
    ["not a url", "invalid_url"],
    ["http://localhost:3000/", "blocked_address"],
    ["http://api.localhost/", "blocked_address"],
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked_address"],
    ["http://intranet/", "blocked_address"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_address"],
    ["http://2130706433/", "blocked_address"],
    ["http://0x7f.1/", "blocked_address"],
    ["http://[::1]:8080/", "blocked_address"],
    ["http://[::ffff:10.0.0.1]/", "blocked_address"],
  ])("refuses %s (%s)", (url, code) => {
    expect(codeOf(() => checkUrlShape(url))).toBe(code);
  });

  it("accepts public http(s) URLs", () => {
    expect(checkUrlShape("https://developer.mozilla.org/fr/docs#x").hostname).toBe("developer.mozilla.org");
    expect(checkUrlShape("http://93.184.216.34/").hostname).toBe("93.184.216.34");
  });
});

describe("resolvePublicAddresses", () => {
  const resolver =
    (answers: Record<string, string[]>): ResolveHost =>
    async (host) =>
      (answers[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("refuses a name that resolves to a private address (DNS rebinding)", async () => {
    const resolve = resolver({ "evil.example": ["10.0.0.5"] });
    await expect(resolvePublicAddresses(new URL("https://evil.example/"), resolve)).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("refuses a mixed answer where any address is private", async () => {
    const resolve = resolver({ "mixed.example": ["93.184.216.34", "169.254.169.254"] });
    await expect(resolvePublicAddresses(new URL("https://mixed.example/"), resolve)).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("returns every public address", async () => {
    const resolve = resolver({ "ok.example": ["93.184.216.34", "2606:2800:220:1::1"] });
    await expect(resolvePublicAddresses(new URL("https://ok.example/"), resolve)).resolves.toHaveLength(2);
  });
});

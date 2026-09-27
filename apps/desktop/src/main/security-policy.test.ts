import { describe, expect, it } from "vitest";
import {
  describeUrlForLog,
  isAllowedExternalUrl,
  isAppOrigin,
  isAppUrl,
  resolveLaunchOverrides,
} from "./security-policy";

describe("isAllowedExternalUrl", () => {
  it.each([
    ["https://openrouter.ai/settings/keys", true],
    ["https://openrouter.ai", true],
    ["https://github.com/Micka420-collab/Nova", true],
    ["https://github.com/micka420-collab/nova/issues/new?title=x", true],
    ["http://openrouter.ai/settings/keys", false],
    ["https://openrouter.ai.evil.com/", false],
    ["https://evil.com/?openrouter.ai", false],
    ["https://user:pass@openrouter.ai/", false],
    ["https://openrouter.ai:8443/", false],
    ["https://github.com/Micka420-collab/NovaEvil", false],
    ["https://github.com/other/Nova", false],
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["not a url", false],
  ])("%s -> %s", (url, allowed) => {
    expect(isAllowedExternalUrl(url)).toBe(allowed);
  });
});

describe("isAppUrl", () => {
  it("accepts the nova://app origin and the dev server origin only", () => {
    expect(isAppUrl("nova://app/index.html", null)).toBe(true);
    expect(isAppUrl("nova://app/", null)).toBe(true);
    expect(isAppUrl("nova://other/index.html", null)).toBe(false);
    expect(isAppUrl("http://localhost:5173/", null)).toBe(false);
    expect(isAppUrl("http://localhost:5173/src/main.tsx", "http://localhost:5173")).toBe(true);
    expect(isAppUrl("http://localhost:5174/", "http://localhost:5173")).toBe(false);
    expect(isAppUrl("file:///index.html", "http://localhost:5173")).toBe(false);
    expect(isAppUrl("about:blank", null)).toBe(false);
  });

  it("accepts only the app and dev origins, never the opaque origin of error pages", () => {
    expect(isAppOrigin("nova://app", null)).toBe(true);
    expect(isAppOrigin("null", null)).toBe(false);
    expect(isAppOrigin("nova://other", null)).toBe(false);
    expect(isAppOrigin("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(isAppOrigin("http://localhost:5173", null)).toBe(false);
  });

  it("logs only scheme and host of a URL", () => {
    expect(describeUrlForLog("https://evil.com/path?token=sk-or-v1-abc")).toBe("https://evil.com");
    expect(describeUrlForLog("%%%")).toBe("invalid-url");
  });
});

describe("resolveLaunchOverrides", () => {
  const env = {
    NOVA_USER_DATA_DIR: "/tmp/nova-e2e",
    NOVA_OPENROUTER_BASE_URL: "http://127.0.0.1:4010/api/v1",
    ELECTRON_RENDERER_URL: "http://localhost:5173/",
  };

  it("ignores every override in a packaged build", () => {
    expect(resolveLaunchOverrides(true, env)).toEqual({
      userDataDir: null,
      openRouterBaseUrl: null,
      rendererDevUrl: null,
      ignored: ["NOVA_USER_DATA_DIR", "NOVA_OPENROUTER_BASE_URL", "ELECTRON_RENDERER_URL"],
    });
  });

  it("accepts loopback URLs and absolute paths in development", () => {
    expect(resolveLaunchOverrides(false, env)).toEqual({
      userDataDir: "/tmp/nova-e2e",
      openRouterBaseUrl: "http://127.0.0.1:4010/api/v1",
      rendererDevUrl: "http://localhost:5173/",
      ignored: [],
    });
    expect(resolveLaunchOverrides(false, {})).toEqual({
      userDataDir: null,
      openRouterBaseUrl: null,
      rendererDevUrl: null,
      ignored: [],
    });
  });

  it("refuses overrides that would send the key or IPC trust off the machine", () => {
    const result = resolveLaunchOverrides(false, {
      NOVA_USER_DATA_DIR: "relative/dir",
      NOVA_OPENROUTER_BASE_URL: "https://attacker.example/api/v1",
      ELECTRON_RENDERER_URL: "http://192.168.1.20:5173/",
    });
    expect(result).toMatchObject({ userDataDir: null, openRouterBaseUrl: null, rendererDevUrl: null });
    expect(result.ignored).toHaveLength(3);
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RENDERER_CSP,
  STYLE_NONCE_META,
  contentTypeFor,
  createStyleNonce,
  injectStyleNonce,
  rendererCspWithNonce,
  resolveRendererFile,
  serveRendererRequest,
} from "./renderer-assets";

let base: string;
let root: string;

beforeAll(() => {
  // realpath: tmpdir may itself be a symlink (macOS /var -> /private/var).
  base = realpathSync(mkdtempSync(join(tmpdir(), "nova-assets-")));
  root = join(base, "renderer");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>NOVA</title>");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "assets", "font.woff2"), "woff2");
  writeFileSync(join(base, "secret.txt"), "outside");
  symlinkSync(join(base, "secret.txt"), join(root, "assets", "escape.txt"));
  symlinkSync(join(root, "assets", "app.js"), join(root, "alias.js"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveRendererFile", () => {
  it("maps app URLs to files inside the renderer directory", async () => {
    await expect(resolveRendererFile(root, "nova://app/")).resolves.toBe(join(root, "index.html"));
    await expect(resolveRendererFile(root, "nova://app/index.html")).resolves.toBe(join(root, "index.html"));
    await expect(resolveRendererFile(root, "nova://app/assets/app.js?v=1#x")).resolves.toBe(
      join(root, "assets", "app.js"),
    );
    // A symlink that stays inside the root is fine.
    await expect(resolveRendererFile(root, "nova://app/alias.js")).resolves.toBe(join(root, "assets", "app.js"));
  });

  it.each([
    "nova://app/../secret.txt",
    "nova://app/..%2Fsecret.txt",
    "nova://app/%2e%2e/secret.txt",
    "nova://app/assets%2F..%2F..%2Fsecret.txt",
    "nova://app/assets/..%5C..%5Csecret.txt",
    "nova://app/assets/escape.txt",
    "nova://app/%E0%A4%A",
    "nova://app/index.html%00.js",
    "nova://evil/index.html",
    "file:///etc/passwd",
    "nova://app/missing.js",
    "not a url",
  ])("refuses %s", async (url) => {
    await expect(resolveRendererFile(root, url)).resolves.toBeNull();
  });
});

describe("serveRendererRequest", () => {
  it("serves files with their content type and the strict CSP", async () => {
    const response = await serveRendererRequest(root, { method: "GET", url: "nova://app/index.html" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.text();
    const nonce = /<meta name="nova-style-nonce" content="([^"]+)">/.exec(body)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toBe(rendererCspWithNonce(nonce ?? ""));
    expect(body).toBe(`<meta name="${STYLE_NONCE_META}" content="${nonce}"><!doctype html><title>NOVA</title>`);
    expect(RENDERER_CSP).toContain("default-src 'none'");
    expect(RENDERER_CSP).toContain("script-src 'self'");
    expect(RENDERER_CSP).not.toContain("unsafe");
  });

  it("gives every HTML load its own style nonce and leaves script-src strict", async () => {
    const load = () => serveRendererRequest(root, { method: "GET", url: "nova://app/" });
    const [first, second] = await Promise.all([load(), load()]);
    const a = first.headers.get("content-security-policy") ?? "";
    const b = second.headers.get("content-security-policy") ?? "";
    expect(a).not.toBe(b);
    for (const csp of [a, b]) {
      expect(csp).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp).toContain("script-src 'self';");
      expect(csp).not.toContain("unsafe");
    }
    // Other assets keep the nonce-less policy.
    const js = await serveRendererRequest(root, { method: "GET", url: "nova://app/assets/app.js" });
    expect(js.headers.get("content-security-policy")).toBe(RENDERER_CSP);
    expect(createStyleNonce()).not.toBe(createStyleNonce());
  });

  it("injects the nonce meta right after <head>", () => {
    expect(injectStyleNonce('<html><head lang="fr"><title>x</title></head></html>', "abc")).toBe(
      '<html><head lang="fr"><meta name="nova-style-nonce" content="abc"><title>x</title></head></html>',
    );
  });

  it("answers 404 for escapes and directories, 405 for other methods, no body for HEAD", async () => {
    for (const url of ["nova://app/assets/escape.txt", "nova://app/assets", "nova://app/..%2Fsecret.txt"]) {
      const response = await serveRendererRequest(root, { method: "GET", url });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toBe(RENDERER_CSP);
    }
    expect((await serveRendererRequest(root, { method: "POST", url: "nova://app/index.html" })).status).toBe(405);
    const head = await serveRendererRequest(root, { method: "HEAD", url: "nova://app/assets/app.js" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    await expect(head.text()).resolves.toBe("");
  });

  it("knows the content types of built assets", () => {
    expect(contentTypeFor("a/b.CSS")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
  });
});

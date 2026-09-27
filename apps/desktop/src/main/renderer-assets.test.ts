import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RENDERER_CSP, contentTypeFor, resolveRendererFile, serveRendererRequest } from "./renderer-assets";

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
    expect(response.headers.get("content-security-policy")).toBe(RENDERER_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toBe("<!doctype html><title>NOVA</title>");
    expect(RENDERER_CSP).toContain("default-src 'none'");
    expect(RENDERER_CSP).toContain("script-src 'self'");
    expect(RENDERER_CSP).not.toContain("unsafe");
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

// Serving the built renderer over nova:// (pure: no Electron import, filesystem injected).
import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { APP_HOST, APP_SCHEME } from "./security-policy";

export const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/**
 * CSP of an HTML page load (ADR-013, D13): the base policy plus a per-load style nonce, so the
 * editor (CodeMirror 6 `EditorView.cspNonce`) can inject its <style> elements without
 * `'unsafe-inline'`. `script-src` is unchanged. The nonce is new for every load of index.html.
 */
export function rendererCspWithNonce(nonce: string): string {
  return RENDERER_CSP.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`);
}

/** Name of the meta tag carrying the style nonce to the page (read once at startup). */
export const STYLE_NONCE_META = "nova-style-nonce";

/** 128 random bits, base64 (CSP nonce grammar: base64 or base64url characters). */
export function createStyleNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Inserts `<meta name="nova-style-nonce" content="…">` right after `<head>`. The nonce is not a
 * secret from the page itself (it is its own policy token): it only lets same-origin code mark
 * the <style> elements it creates. Injected markup still cannot run scripts (script-src 'self').
 */
export function injectStyleNonce(html: string, nonce: string): string {
  const meta = `<meta name="${STYLE_NONCE_META}" content="${nonce}">`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return `${meta}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

/** Vite dev server only: HMR needs inline scripts/styles and its websocket. */
export function devContentSecurityPolicy(devOrigin: string): string {
  const socket = devOrigin.replace(/^http/, "ws");
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface AssetFs {
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

const nodeFs: AssetFs = { realpath, readFile };

/**
 * Maps a `nova://app/...` URL to a file inside `root`, or null when it must not be served:
 * other hosts, malformed encodings, traversal, and symlinks resolving outside the root.
 */
export async function resolveRendererFile(
  root: string,
  requestUrl: string,
  fs: Pick<AssetFs, "realpath"> = nodeFs,
): Promise<string | null> {
  let pathname: string;
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    return isInside(realRoot, realFile) ? realFile : null;
  } catch {
    return null;
  }
}

function assetResponse(
  status: number,
  body: Uint8Array<ArrayBuffer> | string | null,
  contentType: string,
  csp: string = RENDERER_CSP,
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Protocol handler body: GET/HEAD of built renderer files, 404 for anything else.
 * HTML documents get a fresh style nonce (meta tag + CSP header), see `rendererCspWithNonce`.
 */
export async function serveRendererRequest(
  root: string,
  request: Pick<Request, "method" | "url">,
  fs: AssetFs = nodeFs,
  nonce: () => string = createStyleNonce,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return assetResponse(405, "Method not allowed", "text/plain; charset=utf-8");
  }
  const file = await resolveRendererFile(root, request.url, fs);
  // Directories and unreadable files fall through to 404.
  const body = file ? await fs.readFile(file).catch(() => null) : null;
  if (!file || !body) return assetResponse(404, "Not found", "text/plain; charset=utf-8");
  const contentType = contentTypeFor(file);
  if (contentType.startsWith("text/html")) {
    const value = nonce();
    const html = injectStyleNonce(new TextDecoder().decode(body), value);
    return assetResponse(200, request.method === "HEAD" ? null : html, contentType, rendererCspWithNonce(value));
  }
  return assetResponse(200, request.method === "HEAD" ? null : body, contentType);
}

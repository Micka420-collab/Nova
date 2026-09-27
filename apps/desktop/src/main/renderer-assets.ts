// Serving the built renderer over nova:// (pure: no Electron import, filesystem injected).
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

function assetResponse(status: number, body: Uint8Array<ArrayBuffer> | string | null, contentType: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Content-Security-Policy": RENDERER_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
}

/** Protocol handler body: GET/HEAD of built renderer files, 404 for anything else. */
export async function serveRendererRequest(
  root: string,
  request: Pick<Request, "method" | "url">,
  fs: AssetFs = nodeFs,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return assetResponse(405, "Method not allowed", "text/plain; charset=utf-8");
  }
  const file = await resolveRendererFile(root, request.url, fs);
  // Directories and unreadable files fall through to 404.
  const body = file ? await fs.readFile(file).catch(() => null) : null;
  if (!file || !body) return assetResponse(404, "Not found", "text/plain; charset=utf-8");
  return assetResponse(200, request.method === "HEAD" ? null : body, contentTypeFor(file));
}

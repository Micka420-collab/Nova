// Pure security policy of the main process (no Electron import): app origin, external links,
// and the development/E2E overrides read from the environment.
import { isAbsolute } from "node:path";

export const APP_SCHEME = "nova";
export const APP_HOST = "app";
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** External destinations the user may open in the system browser (https only). */
const EXTERNAL_ALLOWLIST: readonly { host: string; pathPrefix?: string }[] = [
  { host: "openrouter.ai" },
  { host: "github.com", pathPrefix: "/micka420-collab/nova" },
];

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * True for pages of the app itself: `nova://app/...` (built renderer) or the dev server origin.
 * Compared on protocol and host: WHATWG `origin` is "null" for custom schemes.
 */
export function isAppUrl(raw: string, devOrigin: string | null): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  if (url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST) return true;
  return devOrigin !== null && url.origin === devOrigin;
}

/** Serialized frame origin of the app: error pages keep the failed URL but get an opaque "null" origin. */
export function isAppOrigin(origin: string, devOrigin: string | null): boolean {
  return origin === `${APP_SCHEME}://${APP_HOST}` || (devOrigin !== null && origin === devOrigin);
}

export function isAllowedExternalUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const path = url.pathname.toLowerCase();
  return EXTERNAL_ALLOWLIST.some(
    ({ host, pathPrefix }) =>
      url.hostname === host &&
      (pathPrefix === undefined || path === pathPrefix || path.startsWith(`${pathPrefix}/`)),
  );
}

/** Scheme and host only: full URLs may carry tokens or model-provided content. */
export function describeUrlForLog(raw: string): string {
  const url = parseUrl(raw);
  return url ? `${url.protocol}//${url.host}` : "invalid-url";
}

function loopbackHttpUrl(raw: string | undefined): URL | null {
  const url = raw ? parseUrl(raw) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
}

export interface LaunchOverrides {
  /** NOVA_USER_DATA_DIR: isolated data directory (E2E). */
  userDataDir: string | null;
  /** NOVA_OPENROUTER_BASE_URL: local OpenRouter mock (E2E). Receives the API key. */
  openRouterBaseUrl: string | null;
  /** ELECTRON_RENDERER_URL: Vite dev server, trusted like the app origin. */
  rendererDevUrl: string | null;
  /** Names of the variables that are set but were ignored. */
  ignored: string[];
}

/**
 * Environment overrides exist for development and E2E only. A packaged build ignores them all;
 * URLs are also limited to loopback so a stray variable cannot send the key or IPC trust elsewhere.
 */
export function resolveLaunchOverrides(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): LaunchOverrides {
  const ignored: string[] = [];
  const read = (name: string, accept: (value: string) => boolean): string | null => {
    const value = env[name];
    if (value === undefined || value === "") return null;
    if (!isPackaged && accept(value)) return value;
    ignored.push(name);
    return null;
  };
  const isLoopbackHttp = (value: string): boolean => loopbackHttpUrl(value) !== null;
  return {
    userDataDir: read("NOVA_USER_DATA_DIR", isAbsolute),
    openRouterBaseUrl: read("NOVA_OPENROUTER_BASE_URL", isLoopbackHttp),
    rendererDevUrl: read("ELECTRON_RENDERER_URL", isLoopbackHttp),
    ignored,
  };
}

// fetch_page (W2), main process only. Every hop: URL shape check → policy authorization → DNS
// resolution with the SSRF guard → connection PINNED to the checked addresses (custom `lookup`,
// no second resolution) → bounded redirects. Body: 5 MB cap (after decompression), 20 s overall
// deadline, allowed content types only; then readable Markdown, capped, cached with a TTL.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import type { FetchedPage } from "@nova/shared";
import { safeWireToken, WebError } from "./errors";
import { bodyToMarkdown, TRUNCATION_MARKER, truncateText } from "./extract";
import {
  checkUrlShape,
  normalizedHostname,
  resolvePublicAddresses,
  systemResolveHost,
  type ResolvedAddress,
  type ResolveHost,
  type SsrfOptions,
} from "./ssrf";

export interface PageFetchLimits {
  /** Max body bytes, after decompression. */
  maxBytes: number;
  /** Overall deadline for all hops and the body. */
  timeoutMs: number;
  maxRedirects: number;
  /** Max Markdown characters kept (≈ 4 characters per token). */
  maxChars: number;
}

export const DEFAULT_PAGE_FETCH_LIMITS: PageFetchLimits = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 5,
  maxChars: 40_000,
};

export const DEFAULT_WEB_CACHE_TTL_MS = 60 * 60 * 1000;

/** One `web_cache` row. `url` is the FINAL URL (after redirects); the key hashes the requested URL. */
export interface WebCacheEntry {
  urlHash: string;
  url: string;
  title: string | null;
  /** Capped Markdown; ends with TRUNCATION_MARKER when the page was truncated. */
  markdown: string;
  contentHash: string;
  fetchedAt: number;
  expiresAt: number;
}

export interface WebCacheStore {
  /** Unexpired entry for the key, or null. */
  get(urlHash: string, now: number): WebCacheEntry | null;
  put(entry: WebCacheEntry): void;
}

/**
 * Called for the requested URL (hop 0) and every redirect target before any connection. Throws a
 * WebError (`policy_denied` / `policy_ask`) to refuse; the SSRF guard is applied separately.
 */
export type HopAuthorizer = (url: URL, hop: number) => void;

export interface FetchPageRequest {
  url: string;
  signal: AbortSignal;
  authorize: HopAuthorizer;
  /** Skip the cache read (the fresh result is still stored). */
  bypassCache?: boolean;
}

export interface PageFetcher {
  fetchPage(request: FetchPageRequest): Promise<FetchedPage>;
}

export interface PageFetcherOptions {
  resolveHost?: ResolveHost;
  ssrf?: SsrfOptions;
  limits?: Partial<PageFetchLimits>;
  cache?: WebCacheStore | null;
  cacheTtlMs?: number;
  now?: () => number;
  userAgent?: string;
}

type BodyKind = "html" | "text" | "json";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = "NOVA/0.1 (+https://github.com/Micka420-collab/Nova; page reader)";

/** Cache identity of a URL: fragment removed (never sent to the server). */
export function cacheUrlKey(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return createHash("sha256").update(copy.href).digest("hex");
}

export function classifyContentType(header: string | undefined): { kind: BodyKind; charset: string } | "pdf" | null {
  if (!header) return null;
  const [rawType = "", ...params] = header.split(";");
  const type = rawType.trim().toLowerCase();
  const charsetParam = params.map((param) => param.trim()).find((param) => param.toLowerCase().startsWith("charset="));
  const charset = charsetParam ? charsetParam.slice("charset=".length).replace(/"/g, "").trim().toLowerCase() : "utf-8";
  if (type === "text/html" || type === "application/xhtml+xml") return { kind: "html", charset };
  if (type === "text/plain" || type === "text/markdown" || type === "text/csv") return { kind: "text", charset };
  if (type === "application/json" || type.endsWith("+json")) return { kind: "json", charset };
  if (type === "application/pdf") return "pdf";
  return null;
}

function decodeBody(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Connection lookup that only ever returns the addresses the SSRF guard already accepted. */
function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : null;
    const candidates = family === null ? addresses : addresses.filter((entry) => entry.family === family);
    const first = candidates[0];
    if (!first) {
      callback(Object.assign(new Error("no pinned address for the requested family"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (options.all) callback(null, candidates.map(({ address, family: f }) => ({ address, family: f })));
    else callback(null, first.address, first.family);
  };
}

function requestOnce(
  url: URL,
  addresses: readonly ResolvedAddress[],
  signal: AbortSignal,
  userAgent: string,
): Promise<http.IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        // No pooled sockets: each hop connects to its own checked addresses.
        agent: false,
        lookup: pinnedLookup(addresses),
        signal,
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "fr,en;q=0.8",
        },
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
}

function decodedStream(response: http.IncomingMessage): Readable {
  const encoding = (response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = zlib.createGunzip();
  else if (encoding === "deflate") decoder = zlib.createInflate();
  else if (encoding === "br") decoder = zlib.createBrotliDecompress();
  else if (encoding !== "identity") throw new WebError("unsupported_content_type", `content encoding ${safeWireToken(encoding)} is not supported`);
  if (!decoder) return response;
  const target = decoder;
  response.on("error", (error) => target.destroy(error));
  return response.pipe(target);
}

async function readCappedBody(response: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new WebError("too_large", `declared size ${declared} bytes exceeds ${maxBytes}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = decodedStream(response);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      response.destroy();
      throw new WebError("too_large", `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createPageFetcher(options: PageFetcherOptions = {}): PageFetcher {
  const limits: PageFetchLimits = { ...DEFAULT_PAGE_FETCH_LIMITS, ...options.limits };
  const resolveHost = options.resolveHost ?? systemResolveHost;
  const ssrf = options.ssrf ?? {};
  const cache = options.cache ?? null;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_WEB_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  function readCache(request: FetchPageRequest, requested: URL): FetchedPage | null {
    let entry: WebCacheEntry | null = null;
    try {
      entry = cache?.get(cacheUrlKey(requested), now()) ?? null;
    } catch {
      entry = null;
    }
    if (!entry) return null;
    // The content came from the final URL: a redirect cached under another policy, mission or
    // workspace must pass the CURRENT authorizer for that host, exactly as a live read would.
    if (cacheUrlKey(new URL(entry.url)) !== cacheUrlKey(requested)) request.authorize(checkUrlShape(entry.url, ssrf), 1);
    return {
      url: requested.href,
      finalUrl: entry.url,
      title: entry.title,
      markdown: entry.markdown,
      fetchedAt: entry.fetchedAt,
      truncated: entry.markdown.endsWith(TRUNCATION_MARKER),
      fromCache: true,
    };
  }

  async function download(start: URL, request: FetchPageRequest, signal: AbortSignal): Promise<FetchedPage> {
    let current = start;
    for (let hop = 0; ; hop += 1) {
      const addresses = await resolvePublicAddresses(current, resolveHost, ssrf);
      signal.throwIfAborted();
      const response = await requestOnce(current, addresses, signal, userAgent);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        response.resume();
        if (hop >= limits.maxRedirects) {
          throw new WebError("too_many_redirects", `more than ${limits.maxRedirects} redirects`, { host: normalizedHostname(current) });
        }
        const next = checkUrlShape(new URL(location, current), ssrf);
        request.authorize(next, hop + 1);
        current = next;
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw new WebError("http_error", `HTTP ${status}`, { host: normalizedHostname(current), status });
      }
      const type = classifyContentType(response.headers["content-type"]);
      if (type === null || type === "pdf") {
        response.resume();
        const mime = response.headers["content-type"]?.split(";")[0];
        const what = type === "pdf" ? "PDF reading is not available yet" : `content type ${safeWireToken(mime)} is not readable`;
        throw new WebError("unsupported_content_type", what, { host: normalizedHostname(current) });
      }
      const bytes = await readCappedBody(response, limits.maxBytes);
      const extracted = bodyToMarkdown(type.kind, decodeBody(bytes, type.charset), current.href);
      const capped = truncateText(extracted.markdown, limits.maxChars);
      const fetchedAt = now();
      const page: FetchedPage = {
        url: start.href,
        finalUrl: current.href,
        title: extracted.title,
        markdown: capped.text,
        fetchedAt,
        truncated: capped.truncated,
        fromCache: false,
      };
      try {
        cache?.put({
          urlHash: cacheUrlKey(start),
          url: current.href,
          title: page.title,
          markdown: page.markdown,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          fetchedAt,
          expiresAt: fetchedAt + ttlMs,
        });
      } catch {
        // A cache write failure never fails the read.
      }
      return page;
    }
  }

  return {
    async fetchPage(request) {
      const start = checkUrlShape(request.url, ssrf);
      request.authorize(start, 0);
      if (!request.bypassCache) {
        const cached = readCache(request, start);
        if (cached) return cached;
      }
      const deadline = AbortSignal.timeout(limits.timeoutMs);
      const signal = AbortSignal.any([request.signal, deadline]);
      try {
        return await download(start, request, signal);
      } catch (error) {
        if (request.signal.aborted) throw new WebError("aborted", "page read cancelled");
        if (deadline.aborted) throw new WebError("timeout", `no complete response within ${limits.timeoutMs} ms`);
        if (error instanceof WebError) throw error;
        // Only the Node error code: socket/TLS/parser messages can quote server-controlled text
        // (certificate names, header bytes), and this message is never fenced as untrusted.
        const code = (error as { code?: unknown } | null)?.code;
        const detail = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
        throw new WebError("network", `page could not be read${detail}`);
      }
    },
  };
}

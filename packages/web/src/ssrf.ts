// SSRF guard (W2/W4): only public http(s) destinations are reachable, whatever the domain policy.
// The check runs on the RESOLVED addresses of every hop, and the connection is pinned to those
// addresses (see page-fetcher.ts), so a DNS answer cannot change between check and connect.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { safeWireToken, WebError } from "./errors";

export interface ResolvedAddress {
  address: string;
  /** 4 or 6. */
  family: number;
}

/** DNS resolution of a hostname to every address (injectable for tests). */
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SsrfOptions {
  /**
   * TEST ONLY: lets 127.0.0.0/8 and ::1 through so tests can use a local HTTP server. Every other
   * refused range (private, link-local, metadata…) stays refused. Never set in the product.
   */
  dangerouslyAllowLoopbackForTests?: boolean;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Refused whatever the policy: non-public, special-purpose and cloud-metadata ranges.
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against the IPv4 list by BlockList itself.
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ["::", 96], // unspecified, loopback ::1, IPv4-compatible
  ["64:ff9b::", 96], // NAT64 (embeds an IPv4 address)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["fc00::", 7], // unique local, incl. AWS metadata fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];

const BLOCKED = new BlockList();
for (const [network, prefix] of BLOCKED_V4) BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of BLOCKED_V6) BLOCKED.addSubnet(network, prefix, "ipv6");

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Hostnames refused by name before any resolution (they may resolve to anything locally). */
function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    // A single-label name is resolved through local search domains: never public.
    (!hostname.includes(".") && isIP(hostname) === 0)
  );
}

/** True when `address` (IPv4 or IPv6 literal) must never be reached. Non-IP input counts as blocked. */
export function isBlockedAddress(address: string, options: SsrfOptions = {}): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (options.dangerouslyAllowLoopbackForTests && LOOPBACK.check(address, type)) return false;
  return BLOCKED.check(address, type);
}

/** URL hostname without IPv6 brackets and trailing dot, lowercase. */
export function normalizedHostname(url: URL): string {
  const raw = url.hostname.toLowerCase().replace(/\.$/, "");
  return raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
}

/**
 * Parses and checks everything that can be checked without the network: scheme, credentials,
 * blocked hostnames and IP literals (the WHATWG parser already canonicalizes forms such as
 * `http://2130706433/` or `http://0x7f.1/` to 127.0.0.1).
 */
export function checkUrlShape(input: string | URL, options: SsrfOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new WebError("invalid_url", "not a valid absolute URL");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new WebError("invalid_url", `scheme ${safeWireToken(url.protocol.slice(0, -1))} is not allowed (http and https only)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebError("invalid_url", "credentials in URLs are refused");
  }
  const host = normalizedHostname(url);
  if (host === "") throw new WebError("invalid_url", "URL has no host");
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host, options)) {
      throw new WebError("blocked_address", "destination address is not public", { host });
    }
  } else if (isBlockedHostname(host)) {
    throw new WebError("blocked_address", "destination host is local or internal", { host });
  }
  return url;
}

export const systemResolveHost: ResolveHost = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family }));

/**
 * Resolves the URL host and returns addresses that are ALL public; one blocked address refuses
 * the host (a mixed answer is a rebinding/split-horizon attempt, or a misconfiguration).
 */
export async function resolvePublicAddresses(
  url: URL,
  resolve: ResolveHost,
  options: SsrfOptions = {},
): Promise<ResolvedAddress[]> {
  const host = normalizedHostname(url);
  const literal = isIP(host);
  if (literal !== 0) {
    if (isBlockedAddress(host, options)) throw new WebError("blocked_address", "destination address is not public", { host });
    return [{ address: host, family: literal }];
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new WebError("network", "host could not be resolved", { host });
  }
  if (addresses.length === 0) throw new WebError("network", "host resolved to no address", { host });
  if (addresses.some(({ address }) => isBlockedAddress(address, options))) {
    throw new WebError("blocked_address", "host resolves to a non-public address", { host });
  }
  return addresses;
}

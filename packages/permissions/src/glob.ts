// Minimal gitignore-like glob matching on canonical relative paths ("a/b/c.ts").
// Supported: `*` (any run inside a segment), `?` (one character inside a segment), `**` (any number
// of whole segments). A pattern without "/" matches the last segment of the path at any depth
// (`*.pem` matches `certs/site.pem`), like gitignore. Matching is case-sensitive.

const cache = new Map<string, RegExp>();
const CACHE_MAX = 500;

function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function segmentSource(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += escapeLiteral(char);
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const segments = trimmed.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      // `a/**` matches everything below a; `**/b` matches b at any depth.
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += segmentSource(segment) + (last ? "" : "/");
  });
  // A directory pattern also matches everything inside it (`node_modules` → `node_modules/x`).
  const full = `${anchored ? "^" : "^(?:.*/)?"}${source}(?:/.*)?$`;
  const regex = new RegExp(full);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(pattern, regex);
  return regex;
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

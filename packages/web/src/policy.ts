// Domain policy (W4): allow / ask / deny per host pattern, global and per workspace, with presets.
// Evaluation order: workspace rules, then global rules; inside a scope the most specific pattern
// wins; no match → `defaultAction`. A mission contract (allowedHosts) can only restrict: a host
// outside its list is denied, a host inside it keeps the policy action (deny stays deny).
// The SSRF guard (ssrf.ts) runs independently of this policy and cannot be relaxed by it.
import type { WebPolicy, WebPolicyPreset, WebPolicyRule, WebPolicySetRequest, WebRuleAction } from "@nova/shared";

/** Pattern of the stored catch-all rule that holds a scope's `defaultAction`. */
export const DEFAULT_RULE_PATTERN = "*";
/** Global default when nothing is configured: every destination is confirmed first. */
export const FALLBACK_DEFAULT_ACTION: WebRuleAction = "ask";

export interface PresetDefinition {
  /** French UI label. */
  label: string;
  /** French UI description. */
  description: string;
  defaultAction: WebRuleAction;
  rules: readonly { pattern: string; action: WebRuleAction }[];
}

// Documentation sites of mainstream languages and tools. Domain names, not model ids: they are
// product content (the preset), reviewed like copy. `*.x` also matches the apex `x`.
const DEV_DOCS_HOSTS = [
  "*.mozilla.org",
  "*.nodejs.org",
  "*.npmjs.com",
  "*.typescriptlang.org",
  "*.react.dev",
  "*.vuejs.org",
  "*.svelte.dev",
  "*.vitejs.dev",
  "vitest.dev",
  "playwright.dev",
  "*.electronjs.org",
  "*.python.org",
  "*.readthedocs.io",
  "*.rust-lang.org",
  "docs.rs",
  "crates.io",
  "go.dev",
  "pkg.go.dev",
  "*.kotlinlang.org",
  "learn.microsoft.com",
  "docs.github.com",
  "stackoverflow.com",
  "*.w3.org",
  "*.whatwg.org",
  "*.sqlite.org",
  "*.postgresql.org",
  "*.docker.com",
  "tailwindcss.com",
] as const;

export const WEB_POLICY_PRESET_DEFINITIONS: Readonly<Record<WebPolicyPreset, PresetDefinition>> = {
  dev_docs: {
    label: "Docs de développement",
    description: "Les sites de documentation courants sont autorisés ; NOVA te demande avant tout autre site.",
    defaultAction: "ask",
    rules: DEV_DOCS_HOSTS.map((pattern) => ({ pattern, action: "allow" as const })),
  },
  no_internet: {
    label: "Aucun Internet",
    description: "Aucune page ni recherche : tout accès à Internet est refusé.",
    defaultAction: "deny",
    rules: [],
  },
  ask_everything: {
    label: "Ouvert avec confirmation",
    description: "Tous les sites publics sont possibles, mais NOVA te demande avant chaque nouveau site.",
    defaultAction: "ask",
    rules: [],
  },
};

/** Lowercase host without trailing dot and IPv6 brackets. */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

/** `example.com` matches exactly; `*.example.com` matches `example.com` and any subdomain. */
export function matchHostPattern(pattern: string, host: string): boolean {
  const target = normalizeHost(host);
  if (pattern === DEFAULT_RULE_PATTERN) return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return target === base || target.endsWith(`.${base}`);
  }
  return target === pattern;
}

/** Higher = more specific: more labels first, then exact before wildcard. */
export function patternSpecificity(pattern: string): number {
  if (pattern === DEFAULT_RULE_PATTERN) return 0;
  const wildcard = pattern.startsWith("*.");
  const labels = (wildcard ? pattern.slice(2) : pattern).split(".").length;
  return labels * 2 + (wildcard ? 0 : 1);
}

/** Rules in evaluation order: workspace before global, then most specific, then pattern (stable). */
export function orderPolicyRules(rules: readonly WebPolicyRule[]): WebPolicyRule[] {
  return [...rules].sort(
    (a, b) =>
      Number(a.workspaceId === null) - Number(b.workspaceId === null) ||
      patternSpecificity(b.pattern) - patternSpecificity(a.pattern) ||
      a.pattern.localeCompare(b.pattern),
  );
}

export type WebPolicyReason = "rule" | "default" | "mission_restriction";

export interface WebPolicyDecision {
  action: WebRuleAction;
  host: string;
  /** Matching rule (explainability), null for the default action or a mission restriction. */
  rule: WebPolicyRule | null;
  reason: WebPolicyReason;
}

/** Evaluates `host` (or a URL's host) under the policy, restricted by the mission hosts when given. */
export function evaluateWebPolicy(
  target: URL | string,
  policy: WebPolicy,
  missionHosts: readonly string[] | null,
): WebPolicyDecision {
  const host = normalizeHost(typeof target === "string" ? target : target.hostname);
  if (missionHosts !== null && !missionHosts.some((pattern) => matchHostPattern(pattern, host))) {
    return { action: "deny", host, rule: null, reason: "mission_restriction" };
  }
  const rule = orderPolicyRules(policy.rules).find((candidate) => matchHostPattern(candidate.pattern, host));
  if (rule) return { action: rule.action, host, rule, reason: "rule" };
  return { action: policy.defaultAction, host, rule: null, reason: "default" };
}

export interface PlannedScope {
  defaultAction: WebRuleAction;
  rules: { pattern: string; action: WebRuleAction; preset: WebPolicyPreset | null }[];
}

/**
 * Computes the new rules of ONE scope from a `web.setPolicy` request and that scope's current rules.
 * - No preset: the request rules become the scope rules; a rule identical (pattern + action) to an
 *   existing preset rule keeps its preset tag; `defaultAction` comes from the request.
 * - Preset: preset-created rules are replaced by the preset's rules; the request's user rules are
 *   kept and win over a preset rule with the same pattern; `defaultAction` is the preset's.
 */
export function planPolicyScope(request: WebPolicySetRequest, current: readonly WebPolicyRule[]): PlannedScope {
  const presetTagOf = (pattern: string, action: WebRuleAction): WebPolicyPreset | null =>
    current.find((rule) => rule.preset !== null && rule.pattern === pattern && rule.action === action)?.preset ?? null;
  const byPattern = new Map<string, PlannedScope["rules"][number]>();

  if (request.preset === null) {
    for (const { pattern, action } of request.rules) {
      if (pattern === DEFAULT_RULE_PATTERN) continue;
      byPattern.set(pattern, { pattern, action, preset: presetTagOf(pattern, action) });
    }
    return { defaultAction: request.defaultAction, rules: [...byPattern.values()] };
  }

  const definition = WEB_POLICY_PRESET_DEFINITIONS[request.preset];
  for (const { pattern, action } of definition.rules) byPattern.set(pattern, { pattern, action, preset: request.preset });
  for (const { pattern, action } of request.rules) {
    // Old preset rules echoed back by the renderer are dropped: the new preset replaces them.
    if (pattern === DEFAULT_RULE_PATTERN || presetTagOf(pattern, action) !== null) continue;
    byPattern.set(pattern, { pattern, action, preset: null });
  }
  return { defaultAction: definition.defaultAction, rules: [...byPattern.values()] };
}

/** Domain filters for the OpenRouter web plugin, derived from the policy (W1 ← W4). */
export interface SearchDomainFilters {
  /** Empty = no restriction. */
  includeDomains: string[];
  excludeDomains: string[];
}

const stripWildcard = (pattern: string): string => (pattern.startsWith("*.") ? pattern.slice(2) : pattern);

/**
 * `null` when the policy leaves nothing searchable (default deny without allow rules, or a mission
 * with no host): the caller must refuse the search instead of sending an unrestricted one.
 */
export function searchDomainFilters(policy: WebPolicy, missionHosts: readonly string[] | null): SearchDomainFilters | null {
  const ordered = orderPolicyRules(policy.rules);
  // A deny rule shadowed by a workspace rule for the same domain is not excluded.
  const excludeDomains = [
    ...new Set(
      ordered
        .filter((rule) => rule.action === "deny")
        .map((rule) => stripWildcard(rule.pattern))
        .filter((domain) => evaluateWebPolicy(domain, policy, null).action === "deny"),
    ),
  ];
  let includeDomains: string[] = [];
  if (missionHosts !== null) {
    includeDomains = missionHosts.map(stripWildcard);
  } else if (policy.defaultAction === "deny") {
    includeDomains = ordered.filter((rule) => rule.action !== "deny").map((rule) => stripWildcard(rule.pattern));
  }
  includeDomains = [...new Set(includeDomains)].filter((domain) => !excludeDomains.includes(domain));
  const restricted = missionHosts !== null || policy.defaultAction === "deny";
  if (restricted && includeDomains.length === 0) return null;
  return { includeDomains, excludeDomains };
}

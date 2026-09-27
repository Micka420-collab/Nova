// Internet access (W1/W2/W4). Evaluated in main for fetch_page, web_search, remote MCP and (J2-B)
// the agent browser. Private/loopback/link-local ranges and cloud metadata are ALWAYS refused
// (SSRF guard), whatever the rules say. A mission contract can restrict, never widen, this policy.
import { z } from "zod";
import { EntityIdSchema, HostPatternSchema } from "./ids";

export type WebRuleAction = "allow" | "ask" | "deny";

export const WEB_POLICY_PRESETS = ["dev_docs", "no_internet", "ask_everything"] as const;
export type WebPolicyPreset = (typeof WEB_POLICY_PRESETS)[number];

export interface WebPolicyRule {
  id: string;
  /** Domain (`example.com`) or subdomain wildcard (`*.example.com`), lowercase. */
  pattern: string;
  action: WebRuleAction;
  /** null = global rule. */
  workspaceId: string | null;
  /** Preset that created the rule, if any (user rules: null). */
  preset: WebPolicyPreset | null;
}

export interface WebPolicy {
  workspaceId: string | null;
  /** Action for hosts that match no rule. */
  defaultAction: WebRuleAction;
  /** Rules in evaluation order: most specific pattern first; workspace rules before global ones. */
  rules: WebPolicyRule[];
}

export interface WebCitation {
  url: string;
  title: string;
  /** Excerpt returned by the search engine (untrusted). */
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  /** Only URLs actually returned as `url_citation` annotations: no invented citation. */
  citations: WebCitation[];
  engine: string;
  /** Cost reported for the search call; null = unknown. */
  costUsd: number | null;
}

export interface FetchedPage {
  url: string;
  /** After redirects (bounded). */
  finalUrl: string;
  title: string | null;
  /** Readable content (Readability on linkedom → turndown), capped. Untrusted. */
  markdown: string;
  fetchedAt: number;
  truncated: boolean;
  fromCache: boolean;
}

export const WebPolicyGetRequestSchema = z.object({ workspaceId: EntityIdSchema.nullable() });
export const WebPolicySetRequestSchema = z.object({
  workspaceId: EntityIdSchema.nullable(),
  defaultAction: z.enum(["allow", "ask", "deny"]),
  rules: z
    .array(z.object({ pattern: HostPatternSchema, action: z.enum(["allow", "ask", "deny"]) }))
    .max(500),
  /** Applying a preset replaces preset-created rules of the same scope; user rules are kept. */
  preset: z.enum(WEB_POLICY_PRESETS).nullable(),
});
export type WebPolicyGetRequest = z.infer<typeof WebPolicyGetRequestSchema>;
export type WebPolicySetRequest = z.infer<typeof WebPolicySetRequestSchema>;

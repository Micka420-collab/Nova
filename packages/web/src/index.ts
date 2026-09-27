// @nova/web — domain policy (W4), page reading (W2) and web search (W1), used from MAIN only
// (workers have no network).
//
// Contract for the feature implementation:
// - SSRF guard first, whatever the rules: refuse non-http(s), credentials in URLs, private,
//   loopback, link-local and cloud-metadata addresses — checked on the RESOLVED IP of every hop
//   (bounded redirects). Then rules: workspace before global, most specific pattern first, else
//   `defaultAction`. A mission contract restricts (allowedHosts), never widens.
// - fetch_page: size ≤ 5 MB, timeout 20 s, allowed content types; Readability (@mozilla/readability)
//   over linkedom, then turndown to Markdown; cached in `web_cache` with TTL.
// - web_search: short call to an inexpensive model with the OpenRouter `web` plugin; citations come
//   ONLY from `url_citation` annotations; cost recorded with usage kind `web_search`.
// - Everything returned is untrusted content (W5).
import type { FetchedPage, WebPolicy, WebRuleAction, WebSearchResult } from "@nova/shared";

export interface WebPolicyEvaluator {
  /** Action for a URL under the policy (and the mission's allowed hosts when given). */
  evaluate(url: URL, policy: WebPolicy, missionHosts: readonly string[] | null): WebRuleAction;
}

export interface PageFetcher {
  fetchPage(url: string, signal: AbortSignal): Promise<FetchedPage>;
}

export interface WebSearcher {
  search(query: string, options: { maxResults: number; includeDomains: string[]; excludeDomains: string[] }, signal: AbortSignal): Promise<WebSearchResult>;
}

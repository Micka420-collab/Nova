// @nova/web — domain policy (W4), page reading (W2), web search (W1) and untrusted-content
// defenses (W5). Used from MAIN only (workers have no network).
//
// - SSRF guard first, whatever the rules: non-http(s), credentials in URLs, private, loopback,
//   link-local and cloud-metadata addresses are refused on the RESOLVED IP of every hop, and the
//   connection is pinned to the checked addresses (ssrf.ts, page-fetcher.ts).
// - Rules: workspace before global, most specific pattern first, else `defaultAction`. A mission
//   contract restricts (allowedHosts), never widens (policy.ts).
// - fetch_page: ≤ 5 MB, 20 s, ≤ 5 redirects re-checked each hop, allowed content types; Readability
//   over linkedom → turndown; capped with `truncated`; cached in `web_cache` with a TTL.
// - web_search: short completion on an inexpensive catalog model with the OpenRouter `web` plugin;
//   citations only from `url_citation` annotations; cost recorded as usage kind `web_search`.
// - Everything returned is untrusted: wrap it (untrusted.ts) before it reaches a model.
export { isWebError, WebError, type WebErrorCode } from "./errors";
export {
  checkUrlShape,
  isBlockedAddress,
  normalizedHostname,
  resolvePublicAddresses,
  systemResolveHost,
  type ResolvedAddress,
  type ResolveHost,
  type SsrfOptions,
} from "./ssrf";
export {
  DEFAULT_RULE_PATTERN,
  evaluateWebPolicy,
  FALLBACK_DEFAULT_ACTION,
  matchHostPattern,
  normalizeHost,
  orderPolicyRules,
  patternSpecificity,
  planPolicyScope,
  searchDomainFilters,
  WEB_POLICY_PRESET_DEFINITIONS,
  type PlannedScope,
  type PresetDefinition,
  type SearchDomainFilters,
  type WebPolicyDecision,
  type WebPolicyReason,
} from "./policy";
export { bodyToMarkdown, htmlToMarkdown, TRUNCATION_MARKER, truncateText, type ExtractedPage } from "./extract";
export {
  cacheUrlKey,
  classifyContentType,
  createPageFetcher,
  DEFAULT_PAGE_FETCH_LIMITS,
  DEFAULT_WEB_CACHE_TTL_MS,
  type FetchPageRequest,
  type HopAuthorizer,
  type PageFetcher,
  type PageFetcherOptions,
  type PageFetchLimits,
  type WebCacheEntry,
  type WebCacheStore,
} from "./page-fetcher";
export {
  buildWebPlugin,
  createOpenRouterWebSearcher,
  DEFAULT_SEARCH_MAX_RESULTS,
  extractCitations,
  parseWebSearchCompletion,
  pickWebSearchModel,
  type OpenRouterWebPlugin,
  type OpenRouterWebSearcher,
  type OpenRouterWebSearcherDeps,
  type SearchFetch,
  type WebPluginOptions,
  type WebSearchOutcome,
  type WebSearchRequest,
} from "./search";
export { wrapUntrustedPage, wrapUntrustedSearch, type UntrustedPageInput } from "./untrusted";
export {
  inspectOutgoing,
  type ExfiltrationFinding,
  type ExfiltrationFindingKind,
  type OutgoingInspection,
  type OutgoingRequest,
} from "./exfiltration";


// Internet for the agent and the chat (W1, W2, W4, W5), main process only.
// - Policy (W4): `web.getPolicy` / `web.setPolicy` over the web_policy_rules repo; evaluation and
//   precedence belong to @nova/web (`evaluateWebPolicy`, `orderPolicyRules`).
// - fetchPage (W2): exfiltration check of the URL → per-hop policy authorization (ask needs an
//   approved host) → SSRF-guarded, pinned fetch (@nova/web) → wrapped as untrusted (W5).
// - webSearch (W1): policy-derived domain filters → OpenRouter web plugin → citations from
//   annotations only → usage recorded with kind `web_search`.
// The permission engine (S1) still decides the tool call itself; this service is the web gate.
import type { RuntimeLogger } from "@nova/agent-runtime";
import type {
  FetchedPage,
  Provenance,
  ProviderId,
  UsageSummary,
  WebPolicy,
  WebPolicyGetRequest,
  WebPolicyPreset,
  WebPolicyRule,
  WebPolicySetRequest,
  WebRuleAction,
} from "@nova/shared";
import {
  buildWebPlugin,
  checkUrlShape,
  createPageFetcher,
  DEFAULT_SEARCH_MAX_RESULTS,
  evaluateWebPolicy,
  inspectOutgoing,
  normalizeHost,
  orderPolicyRules,
  planPolicyScope,
  searchDomainFilters,
  WebError,
  wrapUntrustedPage,
  wrapUntrustedSearch,
  type OpenRouterWebPlugin,
  type OpenRouterWebSearcher,
  type PageFetcher,
  type PageFetcherOptions,
  type WebCacheStore,
  type WebPolicyDecision,
  type WebSearchOutcome,
} from "@nova/web";
import { ServiceError } from "../service-error";
import type { AuditService } from "./audit-service";

/** Structural view of @nova/storage `WebPolicyRepo` (createWebPolicyRepo). */
export interface WebPolicyStore {
  getPolicy(workspaceId: string | null): WebPolicy;
  scopeRules(workspaceId: string | null): WebPolicyRule[];
  replaceScope(
    workspaceId: string | null,
    write: {
      defaultAction: WebRuleAction;
      rules: readonly { pattern: string; action: WebRuleAction; preset: WebPolicyPreset | null }[];
    },
  ): WebPolicy;
}

/** Structural view of @nova/storage `WebSearchUsageRepo` (createWebSearchUsageRepo). */
export interface WebSearchUsageSink {
  record(input: {
    providerId: string;
    modelId: string;
    servedModel: string | null;
    servedProvider: string | null;
    usage: UsageSummary | null;
    conversationId: string | null;
    messageId: string | null;
    missionId: string | null;
    toolCallId: string | null;
  }): void;
}

export interface WebServiceDeps {
  policies: WebPolicyStore;
  /** S5: a policy change (e.g. allowing every site) is a user action in the audit log. */
  audit?: Pick<AuditService, "recordUserAction">;
  /** `web_cache` repo (createWebCacheRepo); null disables caching. */
  cache: WebCacheStore | null;
  usage: WebSearchUsageSink;
  searcher: OpenRouterWebSearcher;
  /** Provider that bills the search call (recorded in usage_records). */
  providerId: ProviderId;
  /** Literal secrets in use (e.g. the resolved API key) for the exfiltration guard; never logged. */
  knownSecrets?: () => readonly string[];
  /** Page fetcher options (limits, resolver; tests: SSRF loopback override). */
  fetcher?: Omit<PageFetcherOptions, "cache" | "now">;
  now?: () => number;
  logger?: RuntimeLogger;
}

/** Where a call happens: the workspace policy applies, the mission contract restricts. */
export interface WebCallContext {
  workspaceId: string | null;
  /** `MissionContract.allowedHosts` for mission calls; null outside a mission (no restriction). */
  missionHosts: readonly string[] | null;
}

export interface FetchPageInput {
  url: string;
  context: WebCallContext;
  /** Hosts the user approved for this call (answers a `policy_ask`). */
  approvedHosts?: readonly string[];
  /** Workspace texts in the context, for the exfiltration heuristic. */
  workspaceTexts?: readonly string[];
  bypassCache?: boolean;
  signal: AbortSignal;
}

export interface WebPageToolOutput {
  page: FetchedPage;
  /** Model-facing text: wrapped as untrusted, bounded. */
  content: string;
  provenance: Provenance;
}

export interface WebSearchInput {
  query: string;
  context: WebCallContext;
  maxResults?: number;
  /** Rows the usage record links to (all nullable). */
  usageRef: { conversationId: string | null; messageId: string | null; missionId: string | null; toolCallId: string | null };
  workspaceTexts?: readonly string[];
  signal: AbortSignal;
}

export interface WebSearchToolOutput {
  result: WebSearchOutcome;
  content: string;
  provenance: Provenance;
}

const SILENT_LOGGER: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} };

function isForeignKeyError(error: unknown): boolean {
  return error instanceof Error && /FOREIGN KEY/i.test(error.message);
}

export class WebService {
  private readonly fetcher: PageFetcher;
  private readonly now: () => number;
  private readonly logger: RuntimeLogger;

  constructor(private readonly deps: WebServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? SILENT_LOGGER;
    this.fetcher = createPageFetcher({ ...deps.fetcher, cache: deps.cache, now: this.now });
  }

  // ---------------------------------------------------------------------------
  // Policy (IPC)

  getPolicy(req: WebPolicyGetRequest): WebPolicy {
    const policy = this.deps.policies.getPolicy(req.workspaceId);
    return { ...policy, rules: orderPolicyRules(policy.rules) };
  }

  setPolicy(req: WebPolicySetRequest): WebPolicy {
    const planned = planPolicyScope(req, this.deps.policies.scopeRules(req.workspaceId));
    try {
      const policy = this.deps.policies.replaceScope(req.workspaceId, planned);
      this.deps.audit?.recordUserAction(req.workspaceId, "web.policy_changed", req.workspaceId === null ? "global" : "workspace", {
        preset: req.preset,
        defaultAction: planned.defaultAction,
        rules: planned.rules.length,
      });
      return { ...policy, rules: orderPolicyRules(policy.rules) };
    } catch (error) {
      if (isForeignKeyError(error)) throw new ServiceError("not_found", "Workspace not found");
      throw error;
    }
  }

  /** IPC group `web` for `MainApiDeps.atelier`. */
  ipc(): { getPolicy(req: WebPolicyGetRequest): Promise<WebPolicy>; setPolicy(req: WebPolicySetRequest): Promise<WebPolicy> } {
    return {
      getPolicy: async (req) => this.getPolicy(req),
      setPolicy: async (req) => this.setPolicy(req),
    };
  }

  // ---------------------------------------------------------------------------
  // Decisions

  /**
   * Policy decision for a URL, for the tools lane BEFORE asking the user (ask → approval card).
   * Throws WebError `invalid_url` / `blocked_address` for URLs no policy can allow.
   */
  decide(url: string, context: WebCallContext): WebPolicyDecision {
    const parsed = checkUrlShape(url, this.deps.fetcher?.ssrf);
    return evaluateWebPolicy(parsed, this.deps.policies.getPolicy(context.workspaceId), context.missionHosts);
  }

  // ---------------------------------------------------------------------------
  // fetch_page

  async fetchPage(input: FetchPageInput): Promise<WebPageToolOutput> {
    this.guardOutgoing(input.url, null, input.workspaceTexts);
    const policy = this.deps.policies.getPolicy(input.context.workspaceId);
    // Same spelling as the policy's decision.host (trailing dot, IPv6 brackets): an approval of
    // `docs.example.com.` or `[::1]` must match what authorize() compares.
    const approved = new Set((input.approvedHosts ?? []).map(normalizeHost));
    try {
      const page = await this.fetcher.fetchPage({
        url: input.url,
        signal: input.signal,
        bypassCache: input.bypassCache ?? false,
        authorize: (url, hop) => {
          const decision = evaluateWebPolicy(url, policy, input.context.missionHosts);
          if (decision.action === "allow" || (decision.action === "ask" && approved.has(decision.host))) return;
          const code = decision.action === "deny" ? "policy_denied" : "policy_ask";
          throw new WebError(code, `${hop === 0 ? "host" : "redirect target"} ${decision.host} is ${decision.action}`, {
            host: decision.host,
          });
        },
      });
      return {
        page,
        content: wrapUntrustedPage({ url: page.finalUrl, fetchedAt: page.fetchedAt, title: page.title, markdown: page.markdown }),
        provenance: { source: "web", untrusted: true, ref: page.finalUrl },
      };
    } catch (error) {
      if (error instanceof WebError && (error.code === "blocked_address" || error.code === "policy_denied")) {
        // Destination log (host only: a URL may carry data).
        this.logger.warn("web destination refused", { code: error.code, host: error.host });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // web_search

  async webSearch(input: WebSearchInput): Promise<WebSearchToolOutput> {
    this.guardOutgoing("https://openrouter.ai/", input.query, input.workspaceTexts);
    const filters = searchDomainFilters(this.deps.policies.getPolicy(input.context.workspaceId), input.context.missionHosts);
    if (!filters) throw new WebError("policy_denied", "the domain policy leaves no searchable domain");
    const result = await this.deps.searcher.search({
      query: input.query,
      plugin: { maxResults: input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, filters },
      signal: input.signal,
    });
    this.deps.usage.record({
      providerId: this.deps.providerId,
      modelId: result.modelId,
      servedModel: result.servedModel,
      servedProvider: result.servedProvider,
      usage: result.usage,
      ...input.usageRef,
    });
    return {
      result,
      content: wrapUntrustedSearch(result, this.now()),
      provenance: { source: "web", untrusted: true, ref: `recherche : ${result.query}` },
    };
  }

  /**
   * `plugins` for a chat request when the user turned "Web" on (discuss mode: never automatic).
   * null when Web is off. Throws `policy_denied` when the policy leaves nothing searchable.
   */
  chatWebPlugins(req: { webEnabled: boolean; workspaceId: string | null; maxResults?: number }): OpenRouterWebPlugin[] | null {
    if (!req.webEnabled) return null;
    const filters = searchDomainFilters(this.deps.policies.getPolicy(req.workspaceId), null);
    if (!filters) throw new WebError("policy_denied", "the domain policy leaves no searchable domain");
    return [buildWebPlugin({ maxResults: req.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, filters })];
  }

  private guardOutgoing(url: string, body: string | null, workspaceTexts: readonly string[] | undefined): void {
    const inspection = inspectOutgoing({
      url,
      body,
      knownSecrets: this.deps.knownSecrets?.() ?? [],
      workspaceTexts: workspaceTexts ?? [],
    });
    if (!inspection.blocked) return;
    this.logger.warn("outgoing web request blocked by the exfiltration guard", {
      findings: inspection.findings.map((finding) => finding.kind),
    });
    throw new WebError("exfiltration_blocked", "outgoing request looks like an exfiltration", {
      explanation: inspection.explanation,
    });
  }
}

import type { WebPolicy, WebPolicyRule, WebPolicySetRequest } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { evaluateWebPolicy, matchHostPattern, planPolicyScope, searchDomainFilters, WEB_POLICY_PRESET_DEFINITIONS } from "./policy";

let nextId = 0;
function rule(pattern: string, action: WebPolicyRule["action"], workspaceId: string | null = null, preset: WebPolicyRule["preset"] = null): WebPolicyRule {
  nextId += 1;
  return { id: `r${nextId}`, pattern, action, workspaceId, preset };
}

const WS = "11111111-1111-4111-8111-111111111111";

describe("matchHostPattern", () => {
  it("exact patterns match only the host; wildcards match apex and subdomains", () => {
    expect(matchHostPattern("example.com", "example.com")).toBe(true);
    expect(matchHostPattern("example.com", "www.example.com")).toBe(false);
    expect(matchHostPattern("*.example.com", "example.com")).toBe(true);
    expect(matchHostPattern("*.example.com", "a.b.example.com")).toBe(true);
    expect(matchHostPattern("*.example.com", "badexample.com")).toBe(false);
    expect(matchHostPattern("*.example.com", "example.com.evil.net")).toBe(false);
    expect(matchHostPattern("example.com", "EXAMPLE.com.")).toBe(true);
  });
});

describe("evaluateWebPolicy", () => {
  const policy: WebPolicy = {
    workspaceId: WS,
    defaultAction: "ask",
    rules: [
      rule("*.example.com", "deny"),
      rule("docs.example.com", "allow"),
      rule("*.npmjs.com", "allow"),
      rule("*.npmjs.com", "deny", WS),
    ],
  };

  it("most specific pattern wins inside a scope", () => {
    expect(evaluateWebPolicy("docs.example.com", policy, null)).toMatchObject({ action: "allow", reason: "rule" });
    expect(evaluateWebPolicy("api.example.com", policy, null)).toMatchObject({ action: "deny", reason: "rule" });
  });

  it("workspace rules come before global ones", () => {
    expect(evaluateWebPolicy("registry.npmjs.com", policy, null).action).toBe("deny");
  });

  it("unmatched hosts get the default action", () => {
    expect(evaluateWebPolicy(new URL("https://other.org/x"), policy, null)).toMatchObject({ action: "ask", reason: "default", rule: null });
  });

  it("a mission contract restricts but never widens", () => {
    // Outside the mission hosts: denied although the policy allows it.
    expect(evaluateWebPolicy("docs.example.com", policy, ["other.org"])).toMatchObject({ action: "deny", reason: "mission_restriction" });
    // Inside the mission hosts: the policy still decides (deny stays deny, ask stays ask).
    expect(evaluateWebPolicy("api.example.com", policy, ["*.example.com"]).action).toBe("deny");
    expect(evaluateWebPolicy("other.org", policy, ["other.org"]).action).toBe("ask");
  });
});

describe("planPolicyScope", () => {
  const request = (patch: Partial<WebPolicySetRequest>): WebPolicySetRequest => ({
    workspaceId: null,
    defaultAction: "ask",
    rules: [],
    preset: null,
    ...patch,
  });

  it("applying a preset replaces preset rules, keeps user rules, and sets the preset default", () => {
    const current = [rule("*.mozilla.org", "allow", null, "dev_docs"), rule("my.site", "allow")];
    const planned = planPolicyScope(
      request({ preset: "no_internet", rules: [{ pattern: "*.mozilla.org", action: "allow" }, { pattern: "my.site", action: "allow" }] }),
      current,
    );
    expect(planned.defaultAction).toBe("deny");
    expect(planned.rules).toEqual([{ pattern: "my.site", action: "allow", preset: null }]);
  });

  it("dev docs preset allows documentation hosts and asks for the rest", () => {
    const planned = planPolicyScope(request({ preset: "dev_docs" }), []);
    expect(planned.defaultAction).toBe(WEB_POLICY_PRESET_DEFINITIONS.dev_docs.defaultAction);
    expect(planned.rules.some((r) => r.pattern === "*.mozilla.org" && r.action === "allow" && r.preset === "dev_docs")).toBe(true);
  });

  it("without a preset, request rules replace the scope and echoed preset rules keep their tag", () => {
    const current = [rule("*.mozilla.org", "allow", null, "dev_docs")];
    const planned = planPolicyScope(
      request({ defaultAction: "deny", rules: [{ pattern: "*.mozilla.org", action: "allow" }, { pattern: "x.org", action: "ask" }, { pattern: "*", action: "allow" }] }),
      current,
    );
    expect(planned.defaultAction).toBe("deny");
    expect(planned.rules).toEqual([
      { pattern: "*.mozilla.org", action: "allow", preset: "dev_docs" },
      { pattern: "x.org", action: "ask", preset: null },
    ]);
  });
});

describe("searchDomainFilters", () => {
  it("excludes denied domains and does not restrict an open policy", () => {
    const policy: WebPolicy = { workspaceId: null, defaultAction: "ask", rules: [rule("*.evil.net", "deny")] };
    expect(searchDomainFilters(policy, null)).toEqual({ includeDomains: [], excludeDomains: ["evil.net"] });
  });

  it("default deny restricts the search to allowed domains, or refuses when there are none", () => {
    const withAllow: WebPolicy = { workspaceId: null, defaultAction: "deny", rules: [rule("*.mozilla.org", "allow")] };
    expect(searchDomainFilters(withAllow, null)).toEqual({ includeDomains: ["mozilla.org"], excludeDomains: [] });
    expect(searchDomainFilters({ workspaceId: null, defaultAction: "deny", rules: [] }, null)).toBeNull();
  });

  it("mission hosts become include_domains", () => {
    const policy: WebPolicy = { workspaceId: null, defaultAction: "ask", rules: [] };
    expect(searchDomainFilters(policy, ["*.nodejs.org"])).toEqual({ includeDomains: ["nodejs.org"], excludeDomains: [] });
    expect(searchDomainFilters(policy, [])).toBeNull();
  });
});

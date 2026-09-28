import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createWebPolicyRepo } from "./web-policy";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;

beforeEach(() => {
  store = openNovaStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("web policy repo", () => {
  it("defaults to ask with no rules", () => {
    expect(createWebPolicyRepo(store.db).getPolicy(null)).toEqual({ workspaceId: null, defaultAction: "ask", rules: [] });
  });

  it("stores each scope's default as a hidden catch-all and merges workspace over global", () => {
    const repo = createWebPolicyRepo(store.db, () => 5);
    const workspace = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: "/tmp/p", name: "p" });
    repo.replaceScope(null, { defaultAction: "deny", rules: [{ pattern: "*.mozilla.org", action: "allow", preset: "dev_docs" }] });

    const inherited = repo.getPolicy(workspace.id);
    expect(inherited.defaultAction).toBe("deny");
    expect(inherited.rules).toEqual([expect.objectContaining({ pattern: "*.mozilla.org", workspaceId: null, preset: "dev_docs" })]);

    repo.replaceScope(workspace.id, { defaultAction: "ask", rules: [{ pattern: "evil.net", action: "deny", preset: null }] });
    const merged = repo.getPolicy(workspace.id);
    expect(merged.defaultAction).toBe("ask");
    expect(merged.rules.map((rule) => [rule.pattern, rule.workspaceId])).toEqual([
      ["evil.net", workspace.id],
      ["*.mozilla.org", null],
    ]);
    // The global view ignores workspace rules, and no rule exposes the catch-all pattern.
    expect(repo.getPolicy(null).rules.map((rule) => rule.pattern)).toEqual(["*.mozilla.org"]);
    expect(repo.scopeRules(workspace.id).map((rule) => rule.pattern)).toEqual(["evil.net"]);
  });

  it("replaces a scope atomically and keeps the first occurrence of a duplicated pattern", () => {
    const repo = createWebPolicyRepo(store.db);
    repo.replaceScope(null, { defaultAction: "ask", rules: [{ pattern: "a.org", action: "allow", preset: null }] });
    const policy = repo.replaceScope(null, {
      defaultAction: "allow",
      rules: [
        { pattern: "b.org", action: "deny", preset: null },
        { pattern: "b.org", action: "allow", preset: null },
      ],
    });
    expect(policy.defaultAction).toBe("allow");
    expect(policy.rules.map((rule) => [rule.pattern, rule.action])).toEqual([["b.org", "deny"]]);
  });

  it("refuses rules for an unknown workspace (foreign key)", () => {
    const repo = createWebPolicyRepo(store.db);
    expect(() =>
      repo.replaceScope("22222222-2222-4222-8222-222222222222", { defaultAction: "ask", rules: [] }),
    ).toThrow(/FOREIGN KEY/);
    expect(repo.getPolicy(null).defaultAction).toBe("ask");
  });
});

// Internet domain policy rules (W4), table `web_policy_rules` (migration v4).
// A scope (global = workspace_id NULL, or one workspace) stores its `defaultAction` as the catch-all
// rule with pattern `*`: one table, cascade-deleted with the workspace, never exposed as a rule.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WebPolicy, WebPolicyPreset, WebPolicyRule, WebRuleAction } from "@nova/shared";
import { readText, readTextOrNull, withTransaction, type Row } from "../sqlite";

/** Pattern of the catch-all row that holds a scope's default action. */
export const WEB_DEFAULT_RULE_PATTERN = "*";
/** Default when neither the workspace nor the global scope sets one: confirm every destination. */
export const WEB_FALLBACK_DEFAULT_ACTION: WebRuleAction = "ask";

export interface WebPolicyScopeWrite {
  defaultAction: WebRuleAction;
  rules: readonly { pattern: string; action: WebRuleAction; preset: WebPolicyPreset | null }[];
}

export interface WebPolicyRepo {
  /**
   * Effective policy: global rules, plus the workspace's when `workspaceId` is given (each rule
   * carries its scope). `defaultAction`: workspace's, else global's, else `ask`. Rules come in a
   * stable storage order (workspace, then global; by pattern): evaluation order is @nova/web's
   * `orderPolicyRules`, the single owner of precedence.
   */
  getPolicy(workspaceId: string | null): WebPolicy;
  /** Rules of exactly one scope (no catch-all), for planning an update. */
  scopeRules(workspaceId: string | null): WebPolicyRule[];
  /** Replaces every rule of one scope (and its default) atomically; returns the effective policy. */
  replaceScope(workspaceId: string | null, write: WebPolicyScopeWrite): WebPolicy;
}

function toRule(row: Row): WebPolicyRule {
  return {
    id: readText(row, "id"),
    pattern: readText(row, "pattern"),
    // Enum columns are guarded by CHECK constraints; preset is only written from WebPolicyPreset.
    action: readText(row, "action") as WebRuleAction,
    workspaceId: readTextOrNull(row, "workspace_id"),
    preset: readTextOrNull(row, "preset") as WebPolicyPreset | null,
  };
}

export function createWebPolicyRepo(db: DatabaseSync, now: () => number = Date.now): WebPolicyRepo {
  function rowsOf(workspaceId: string | null): WebPolicyRule[] {
    const rows =
      workspaceId === null
        ? db.prepare("SELECT * FROM web_policy_rules WHERE workspace_id IS NULL ORDER BY pattern").all()
        : db.prepare("SELECT * FROM web_policy_rules WHERE workspace_id = ? ORDER BY pattern").all(workspaceId);
    return rows.map(toRule);
  }

  function getPolicy(workspaceId: string | null): WebPolicy {
    const global = rowsOf(null);
    const local = workspaceId === null ? [] : rowsOf(workspaceId);
    const defaultOf = (rules: WebPolicyRule[]): WebRuleAction | null =>
      rules.find((rule) => rule.pattern === WEB_DEFAULT_RULE_PATTERN)?.action ?? null;
    const rules = [...local, ...global].filter((rule) => rule.pattern !== WEB_DEFAULT_RULE_PATTERN);
    return {
      workspaceId,
      defaultAction: defaultOf(local) ?? defaultOf(global) ?? WEB_FALLBACK_DEFAULT_ACTION,
      rules,
    };
  }

  return {
    getPolicy,
    scopeRules(workspaceId) {
      return rowsOf(workspaceId).filter((rule) => rule.pattern !== WEB_DEFAULT_RULE_PATTERN);
    },
    replaceScope(workspaceId, write) {
      withTransaction(db, () => {
        if (workspaceId === null) db.prepare("DELETE FROM web_policy_rules WHERE workspace_id IS NULL").run();
        else db.prepare("DELETE FROM web_policy_rules WHERE workspace_id = ?").run(workspaceId);
        const insert = db.prepare(
          `INSERT INTO web_policy_rules (id, workspace_id, pattern, action, preset, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const at = now();
        insert.run(randomUUID(), workspaceId, WEB_DEFAULT_RULE_PATTERN, write.defaultAction, null, at);
        const seen = new Set<string>([WEB_DEFAULT_RULE_PATTERN]);
        for (const rule of write.rules) {
          // The unique index would reject a duplicate pattern: the first occurrence wins.
          if (seen.has(rule.pattern)) continue;
          seen.add(rule.pattern);
          insert.run(randomUUID(), workspaceId, rule.pattern, rule.action, rule.preset, at);
        }
      });
      return getPolicy(workspaceId);
    },
  };
}

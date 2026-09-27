import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createApprovalRepo } from "./approvals";
import { createAuditRepo } from "./audit";
import { createMissionRepo } from "./missions";
import { createPolicyRepo, type NewPolicy } from "./policies";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1000;
  store = openNovaStore(":memory:");
});
afterEach(() => {
  store.close();
});

function setup(): { workspaceId: string; otherWorkspaceId: string; missionId: string; otherMissionId: string } {
  const workspaces = createWorkspaceRepo(store.db, now);
  const workspace = workspaces.upsertByRootPath({ rootPath: "/p", name: "p" });
  const other = workspaces.upsertByRootPath({ rootPath: "/q", name: "q" });
  const missions = createMissionRepo(store.db, now);
  const mission = {
    workspaceId: workspace.id,
    conversationId: null,
    title: "t",
    goal: "g",
    mode: "fix" as const,
    modelId: null,
    contract: {
      profile: "assisted" as const,
      isolationLevel: "L0" as const,
      allowedOperations: ["read" as const],
      allowedHosts: [],
      maxDurationMs: 900_000,
      budgetUsd: 0.3,
    },
  };
  return {
    workspaceId: workspace.id,
    otherWorkspaceId: other.id,
    missionId: missions.create(mission).id,
    otherMissionId: missions.create(mission).id,
  };
}

function policy(overrides: Partial<NewPolicy>): NewPolicy {
  return {
    workspaceId: null,
    missionId: null,
    tool: null,
    operation: null,
    pathGlob: null,
    host: null,
    decision: "allow",
    scope: "project",
    source: "user",
    expiresAt: null,
    ...overrides,
  };
}

describe("policy repo", () => {
  it("lists global, workspace and mission rules for evaluation, skipping expired and foreign ones", () => {
    const ids = setup();
    const policies = createPolicyRepo(store.db, now);
    const global = policies.insert(policy({ decision: "deny", host: "evil.example" }));
    const project = policies.insert(policy({ workspaceId: ids.workspaceId, operation: "write", tool: "write_file" }));
    const mission = policies.insert(policy({ workspaceId: ids.workspaceId, missionId: ids.missionId, scope: "mission" }));
    policies.insert(policy({ workspaceId: ids.workspaceId, missionId: ids.otherMissionId, scope: "mission" }));
    policies.insert(policy({ workspaceId: ids.otherWorkspaceId }));
    policies.insert(policy({ workspaceId: ids.workspaceId, expiresAt: 500 }));

    expect(policies.listForEvaluation(ids.workspaceId, ids.missionId)).toEqual([global, project, mission]);
    expect(policies.listForEvaluation(ids.workspaceId, null)).toEqual([global, project]);
    expect(project).toMatchObject({ tool: "write_file", operation: "write", scope: "project", source: "user" });
  });

  it("refuses a mission-scoped rule without a mission", () => {
    expect(() => createPolicyRepo(store.db, now).insert(policy({ scope: "mission" }))).toThrow(/mission id/);
  });

  it("revokes user rules and a mission's rules without touching the others", () => {
    const ids = setup();
    const policies = createPolicyRepo(store.db, now);
    const contractRule = policies.insert(policy({ workspaceId: ids.workspaceId, source: "contract" }));
    policies.insert(policy({ workspaceId: ids.workspaceId }));
    policies.insert(policy({ workspaceId: ids.workspaceId, missionId: ids.missionId, scope: "mission" }));

    expect(policies.revokeUserRules(ids.workspaceId)).toBe(2);
    expect(policies.listForEvaluation(ids.workspaceId, ids.missionId)).toEqual([contractRule]);
    expect(policies.delete(contractRule.id)).toBe(true);
    expect(policies.delete(contractRule.id)).toBe(false);
  });

  it("reads and writes the workspace profile", () => {
    const ids = setup();
    const policies = createPolicyRepo(store.db, now);
    expect(policies.getProfile(ids.workspaceId)).toBe("assisted");
    expect(policies.setProfile(ids.workspaceId, "autonomous")).toBe(true);
    expect(policies.getProfile(ids.workspaceId)).toBe("autonomous");
    expect(policies.getProfile("missing")).toBeNull();
    expect(policies.setProfile("missing", "read_only")).toBe(false);
  });
});

describe("approval repo", () => {
  function insert(workspaceId: string, missionId: string | null): ReturnType<ReturnType<typeof createApprovalRepo>["insert"]> {
    return createApprovalRepo(store.db, now).insert({
      workspaceId,
      missionId,
      toolCallId: null,
      request: { tool: "write_file" },
      ruleId: "profile:assisted",
      expiresAt: null,
    });
  }

  it("decides a pending request once; later decisions are refused", () => {
    const ids = setup();
    const approvals = createApprovalRepo(store.db, now);
    const pending = insert(ids.workspaceId, ids.missionId);
    const approved = approvals.decide(pending.id, { status: "approved", scope: "mission" });
    expect(approved).toMatchObject({ status: "approved", scope: "mission", decidedAt: expect.any(Number) });
    expect(approvals.decide(pending.id, { status: "denied" })).toBeNull();
    expect(approvals.get(pending.id)).toEqual(approved);
  });

  it("filters the list and expires pending requests of a mission or all of them", () => {
    const ids = setup();
    const approvals = createApprovalRepo(store.db, now);
    const a = insert(ids.workspaceId, ids.missionId);
    const b = insert(ids.workspaceId, ids.otherMissionId);
    const c = insert(ids.otherWorkspaceId, null);
    approvals.decide(b.id, { status: "denied" });

    expect(approvals.list({ workspaceId: ids.workspaceId }).map((item) => item.id)).toEqual([a.id, b.id]);
    expect(approvals.list({ status: "pending" }).map((item) => item.id)).toEqual([a.id, c.id]);
    expect(approvals.list({ missionId: ids.otherMissionId, status: "denied" }).map((item) => item.id)).toEqual([b.id]);

    expect(approvals.expireForMission(ids.missionId).map((item) => [item.id, item.status])).toEqual([[a.id, "expired"]]);
    expect(approvals.expireAllPending().map((item) => item.id)).toEqual([c.id]);
    expect(approvals.list({ status: "pending" })).toEqual([]);
  });
});

describe("audit repo", () => {
  const entry = {
    workspaceId: "w1",
    missionId: "m1",
    toolCallId: null,
    actor: "agent" as const,
    action: "permission.decision",
    decision: "allow" as const,
    ruleId: "profile:assisted",
    target: "src/cart.ts",
    dataSummary: { operation: "read", bytes: 120 },
    cost: null,
    outcome: null,
  };

  it("appends rows that survive deleted workspaces and lists them newest first with filters", () => {
    const audit = createAuditRepo(store.db, now);
    const first = audit.append(entry);
    const second = audit.append({ ...entry, action: "tool.executed", target: "example.org", dataSummary: { operation: "network", bytesSent: 300 }, cost: 0.002 });
    const third = audit.append({ ...entry, workspaceId: "w2", decision: "deny", actor: "system" });

    expect(audit.list({})).toEqual([third, second, first]);
    expect(audit.list({ workspaceId: "w1" })).toEqual([second, first]);
    expect(audit.list({ action: "tool." })).toEqual([second]);
    expect(audit.list({ action: "tool" })).toEqual([]);
    expect(audit.list({ operation: "network" })).toEqual([second]);
    expect(audit.list({ decision: "deny", actor: "system" })).toEqual([third]);
    expect(audit.list({ since: second.createdAt, until: third.createdAt })).toEqual([second]);
    expect(audit.list({ beforeSeq: second.seq })).toEqual([first]);
    expect(audit.list({ limit: 1 })).toEqual([third]);
    expect(second).toMatchObject({ dataSummary: { operation: "network", bytesSent: 300 }, cost: 0.002 });
  });

  it("purges only rows older than the cutoff", () => {
    const audit = createAuditRepo(store.db, now);
    audit.append(entry);
    const kept = audit.append(entry);
    expect(audit.purgeBefore(kept.createdAt)).toBe(1);
    expect(audit.list({})).toEqual([kept]);
  });
});

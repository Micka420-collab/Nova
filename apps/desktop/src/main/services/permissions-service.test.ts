import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPERATION_CLASSES, type MissionContract, type PermissionRequest } from "@nova/shared";
import {
  createApprovalRepo,
  createAuditRepo,
  createMissionRepo,
  createPolicyRepo,
  createWorkspaceRepo,
  openNovaStore,
  type NovaStore,
} from "@nova/storage";
import { ApprovalsService, type ApprovalEvent } from "./approvals-service";
import { AuditService, DEFAULT_AUDIT_RETENTION_MS } from "./audit-service";
import { PermissionsService } from "./permissions-service";

let store: NovaStore;
let clock: number;
const now = (): number => (clock += 1);

let workspaceId: string;
let missionId: string;
let contract: MissionContract;
let audit: AuditService;
let permissions: PermissionsService;
let approvals: ApprovalsService;
let events: ApprovalEvent[];

beforeEach(() => {
  clock = 1_000_000;
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/projects/shop", name: "shop" }).id;
  missionId = createMissionRepo(store.db, now).create({
    workspaceId,
    conversationId: null,
    title: "Total du panier",
    goal: "Le total du panier est faux",
    mode: "fix",
    modelId: null,
    contract: {
      profile: "assisted",
      isolationLevel: "L0",
      allowedOperations: ["read", "write", "execute"],
      allowedHosts: [],
      maxDurationMs: 900_000,
      budgetUsd: 0.3,
    },
  }).id;
  contract = {
    workspaceId,
    mode: "fix",
    profile: "assisted",
    isolationLevel: "L0",
    allowedOperations: [...OPERATION_CLASSES],
    allowedHosts: ["docs.example.com"],
    webSearch: false,
    maxDurationMs: 900_000,
    budgetUsd: 0.3,
  };
  const policies = createPolicyRepo(store.db, now);
  audit = new AuditService({ repo: createAuditRepo(store.db, now), now });
  permissions = new PermissionsService({
    policies,
    audit,
    isolation: { level: "L0" },
    contractOf: (id) => (id === missionId ? contract : null),
    knownCommands: () => [["pnpm", "vitest", "run"]],
    now,
  });
  events = [];
  approvals = new ApprovalsService({
    approvals: createApprovalRepo(store.db, now),
    policies,
    audit,
    emit: (event) => events.push(event),
  });
});

afterEach(() => {
  store.close();
});

function write(path = "src/cart.ts"): PermissionRequest {
  return { workspaceId, missionId, tool: "write_file", operation: "write", path, mode: "fix" };
}

describe("PermissionsService", () => {
  it("reports the profile with the D2 banner and records profile changes", async () => {
    expect(await permissions.getProfile({ workspaceId })).toEqual({
      workspaceId,
      profile: "assisted",
      isolationLevel: "L0",
      showIsolationBanner: false,
    });
    expect(await permissions.setProfile({ workspaceId, profile: "autonomous" })).toMatchObject({
      profile: "autonomous",
      showIsolationBanner: true,
    });
    expect(audit.list({ action: "permissions.profile_changed" })[0]).toMatchObject({
      actor: "user",
      dataSummary: { from: "assisted", to: "autonomous" },
    });
    await expect(permissions.getProfile({ workspaceId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("records every decision in the audit log before returning it", () => {
    const decision = permissions.evaluate(write(), { toolCallId: null });
    expect(decision).toMatchObject({ decision: "ask", reason: "profile_asks", rememberable: true });
    const denied = permissions.evaluate({ ...write(), tool: "edit_file", mode: "understand" });
    expect(denied).toMatchObject({ decision: "deny", reason: "mode_forbids" });

    const rows = audit.list({ action: "permission.decision" });
    expect(rows.map((row) => [row.decision, row.target, row.dataSummary?.["reason"]])).toEqual([
      ["deny", "src/cart.ts", "mode_forbids"],
      ["ask", "src/cart.ts", "profile_asks"],
    ]);
    expect(rows[0]?.outcome).toContain("Comprendre");
  });

  it("uses the mission contract's profile and routine commands", () => {
    contract = { ...contract, profile: "autonomous" };
    expect(permissions.evaluate(write()).decision).toBe("allow");
    const tests = permissions.evaluate({ workspaceId, missionId, tool: "run_command", operation: "execute", argv: ["pnpm", "vitest", "run", "cart"] });
    expect(tests.decision).toBe("allow");
  });

  it("refuses to decide for an unknown workspace or a foreign contract (nothing may run)", () => {
    expect(() => permissions.evaluate({ ...write(), workspaceId: "nope" })).toThrow(/Workspace not found/);
    contract = { ...contract, workspaceId: "other" };
    expect(() => permissions.evaluate(write())).toThrow(/another workspace/);
  });

  it("never stores secrets from command lines", () => {
    permissions.evaluate({
      workspaceId,
      missionId,
      tool: "run_command",
      operation: "execute",
      argv: ["curl", "-H", "Authorization: Bearer abcdefghijklmnop", "https://docs.example.com"],
    });
    const row = audit.list({ action: "permission.decision" })[0];
    expect(row?.target).not.toContain("abcdefghijklmnop");
    expect(row?.target).toContain("[secret masqué]");
  });
});

describe("ApprovalsService", () => {
  it("waits without timeout until the user decides, then remembers a mission approval", async () => {
    const request = write();
    const decision = permissions.evaluate(request);
    let settled: string | null = null;
    const outcome = approvals.request({ request, decision, toolCallId: null }).then((value) => (settled = value));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeNull();
    expect(events.map((event) => event.type)).toEqual(["approval.requested"]);
    const pending = await approvals.list({ workspaceId, missionId: null, status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.decision).toMatchObject({ reason: "profile_asks", rememberable: true });

    const approved = await approvals.decide({ approvalId: pending[0]?.id ?? "", decision: "approve", scope: "mission" });
    expect(await outcome).toBe("approved");
    expect(approved).toMatchObject({ status: "approved", scope: "mission" });
    expect(events.map((event) => event.type)).toEqual(["approval.requested", "approval.resolved"]);

    // Same operation, same mission: no new question (UX 7.2 rule 2).
    expect(permissions.evaluate(write("src/other.ts"))).toMatchObject({ decision: "allow", reason: "remembered_approval" });
    expect(audit.list({ action: "approval." }).map((row) => row.action)).toEqual(["approval.decided", "approval.requested"]);
  });

  it("refuses to remember a non-rememberable decision and a second decision", async () => {
    const request: PermissionRequest = { workspaceId, missionId, tool: "run_command", operation: "execute", argv: ["git", "push", "--force"] };
    const decision = permissions.evaluate(request);
    expect(decision).toMatchObject({ decision: "ask", reason: "always_ask", rememberable: false });
    const outcome = approvals.request({ request, decision, toolCallId: null });
    const [pending] = await approvals.list({ workspaceId: null, missionId, status: "pending" });
    const approvalId = pending?.id ?? "";

    await expect(approvals.decide({ approvalId, decision: "approve", scope: "project" })).rejects.toMatchObject({ code: "invalid_request" });
    await approvals.decide({ approvalId, decision: "deny", scope: "once" });
    expect(await outcome).toBe("denied");
    await expect(approvals.decide({ approvalId, decision: "approve", scope: "once" })).rejects.toMatchObject({ code: "conflict" });
    // Denying remembers nothing.
    expect(permissions.evaluate(request).decision).toBe("ask");
  });

  it("resolves waiting calls as denied when the mission stops", async () => {
    const request = write();
    const first = approvals.request({ request, decision: permissions.evaluate(request), toolCallId: null });
    const second = approvals.request({ request, decision: permissions.evaluate(request), toolCallId: null });
    expect(approvals.pendingCount).toBe(2);

    const expired = approvals.cancelMission(missionId);
    expect(expired.map((approval) => approval.status)).toEqual(["expired", "expired"]);
    expect(await first).toBe("denied");
    expect(await second).toBe("denied");
    expect(approvals.pendingCount).toBe(0);
    expect(await approvals.list({ workspaceId, missionId, status: "pending" })).toEqual([]);
  });

  it("expires approvals left pending by a previous run", async () => {
    const request = write();
    void approvals.request({ request, decision: permissions.evaluate(request), toolCallId: null });
    const restarted = new ApprovalsService({
      approvals: createApprovalRepo(store.db, now),
      policies: createPolicyRepo(store.db, now),
      audit,
      emit: () => {},
    });
    expect(restarted.expireOrphans()).toBe(1);
    expect(await restarted.list({ workspaceId, missionId: null, status: "expired" })).toHaveLength(1);
  });

  it("rejects requests that are not an ask", async () => {
    const request = { ...write(), tool: "read_file" as const, operation: "read" as const };
    await expect(approvals.request({ request, decision: permissions.evaluate(request), toolCallId: null })).rejects.toMatchObject({
      code: "internal",
    });
  });
});

describe("AuditService", () => {
  it("summarizes tool executions without content and purges past the retention", () => {
    audit.recordToolExecution({
      workspaceId,
      missionId,
      toolCallId: null,
      tool: "fetch_page",
      operation: "network",
      target: "docs.example.com",
      state: "succeeded",
      bytesSent: 512,
      bytesReceived: 20_000,
      costUsd: null,
    });
    const [row] = audit.list({ operation: "network" });
    expect(row).toMatchObject({
      action: "tool.executed",
      target: "docs.example.com",
      outcome: "succeeded",
      dataSummary: { tool: "fetch_page", operation: "network", bytesSent: 512, bytesReceived: 20_000 },
    });

    clock += DEFAULT_AUDIT_RETENTION_MS + 10;
    audit.recordToolExecution({ workspaceId, missionId, toolCallId: null, tool: "read_file", operation: "read", target: "a.ts", state: "succeeded" });
    expect(audit.purgeExpired()).toBe(1);
    expect(audit.list({}).map((entry) => entry.target)).toEqual(["a.ts"]);
  });
});

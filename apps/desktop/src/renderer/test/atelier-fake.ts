// In-memory J2-A groups for renderer tests (workspace, files, git, missions, approvals, checkpoints,
// permissions, web). Pass `fake.overrides` as `FakeSeed.atelier`; drive missions with `emit`.
import type {
  Approval,
  Checkpoint,
  FileEntry,
  GitStatus,
  IpcResult,
  Mission,
  MissionBudget,
  MissionContract,
  MissionDetail,
  MissionEvent,
  MissionPlanResult,
  MissionTask,
  PermissionProfileState,
  ReviewDecision,
  WebPolicy,
  Workspace,
  WorkspaceFacts,
} from "@nova/shared";
import { testId, type AtelierOverrides } from "./fake-bridge";

const ok = <T>(value: T): Promise<IpcResult<T>> => Promise.resolve({ ok: true, value });
const notFound = (message: string): Promise<IpcResult<never>> =>
  Promise.resolve({ ok: false, error: { code: "not_found", message } });

export function makeWorkspace(partial: Partial<Workspace> = {}): Workspace {
  return {
    id: testId(),
    name: "mon-site",
    displayPath: "~/dev/mon-site",
    permissionProfile: "assisted",
    instructionFilesConsent: null,
    createdAt: 1_000,
    lastOpenedAt: 1_000,
    ...partial,
  };
}

export function makeEntry(path: string, kind: FileEntry["kind"] = "file"): FileEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind,
    size: kind === "file" ? 120 : null,
    mtimeMs: 1_000,
    ignored: false,
    outsideWorkspace: false,
  };
}

export function makeContract(workspaceId: string, partial: Partial<MissionContract> = {}): MissionContract {
  return {
    workspaceId,
    mode: "fix",
    profile: "assisted",
    isolationLevel: "L0",
    allowedOperations: ["read", "write", "execute"],
    allowedHosts: [],
    webSearch: false,
    maxDurationMs: 15 * 60_000,
    budgetUsd: 0.5,
    ...partial,
  };
}

export function makeBudget(partial: Partial<MissionBudget> = {}): MissionBudget {
  return {
    budgetUsd: 0.5,
    reservedUsd: 0,
    spentUsd: 0,
    unknownCostCalls: 0,
    dailySpentUsd: 0,
    dailyLimitUsd: 5,
    ...partial,
  };
}

export interface AtelierFakeSeed {
  workspace?: Workspace;
  entries?: FileEntry[];
  git?: GitStatus;
  /** Tasks proposed by `missions.plan`. */
  planTasks?: Array<Pick<MissionTask, "title" | "acceptance">>;
  planEstimate?: MissionPlanResult["estimate"];
  checkpoints?: Checkpoint[];
  webPolicy?: WebPolicy;
}

export interface AtelierFake {
  overrides: AtelierOverrides;
  /** Pushes a mission event to the renderer (as main does) and records it for `missions.get`. */
  emit: (event: DistributiveOmit<MissionEvent, "id" | "seq" | "at"> & { at?: number }) => MissionEvent;
  /** Last mission created by `missions.plan`. */
  mission: () => Mission | null;
  workspace: Workspace;
  decisions: Array<{ approvalId: string; decision: "approve" | "deny"; scope: string }>;
  reviews: ReviewDecision[][];
  approvals: Map<string, Approval>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function createAtelierFake(seed: AtelierFakeSeed = {}): AtelierFake {
  const workspace = seed.workspace ?? makeWorkspace();
  const entries = seed.entries ?? [makeEntry("src", "directory"), makeEntry("package.json")];
  const listeners = new Set<(event: MissionEvent) => void>();
  const missions = new Map<string, { mission: Mission; contract: MissionContract; tasks: MissionTask[]; events: MissionEvent[] }>();
  const approvals = new Map<string, Approval>();
  const decisions: AtelierFake["decisions"] = [];
  const reviews: ReviewDecision[][] = [];
  let seq = 0;
  let last: Mission | null = null;
  let profile: PermissionProfileState = {
    workspaceId: workspace.id,
    profile: workspace.permissionProfile,
    isolationLevel: "L0",
    showIsolationBanner: false,
  };
  let webPolicy: WebPolicy = seed.webPolicy ?? { workspaceId: null, defaultAction: "ask", rules: [] };

  const facts: WorkspaceFacts = {
    workspaceId: workspace.id,
    detectedAt: 1_000,
    packageManager: "pnpm",
    languages: ["typescript"],
    frameworks: ["vite"],
    testRunner: { name: "vitest", command: ["pnpm", "vitest", "run"] },
    devCommand: null,
    buildCommand: null,
    git: seed.git?.available ?? false,
    instructionFiles: [],
  };

  const record = (event: MissionEvent) => {
    const entry = missions.get(event.missionId);
    if (entry && event.type !== "tool.output" && event.type !== "message.delta") entry.events.push(event);
    if (entry && (event.type === "mission.succeeded" || event.type === "mission.failed" || event.type === "mission.cancelled")) {
      const state = event.type === "mission.succeeded" ? "succeeded" : event.type === "mission.failed" ? "failed" : "cancelled";
      entry.mission = { ...entry.mission, state, endedAt: event.at };
    }
    if (event.type === "approval.requested" || event.type === "approval.resolved") approvals.set(event.approval.id, event.approval);
  };

  const emit: AtelierFake["emit"] = (partial) => {
    seq += 1;
    const event = { id: testId(), seq, at: partial.at ?? 2_000 + seq, ...partial } as MissionEvent;
    record(event);
    for (const listener of listeners) listener(event);
    return event;
  };

  const overrides: AtelierOverrides = {
    workspace: {
      open: () => ok(workspace),
      recent: () => ok([workspace]),
      facts: () => ok(facts),
      close: () => ok(undefined),
    },
    files: {
      list: ({ path }) => ok(entries.filter((entry) => (path === "" ? !entry.path.includes("/") : entry.path.startsWith(`${path}/`)))),
    },
    git: {
      status: () => ok(seed.git ?? { available: false }),
      diff: () => ok({ patch: "", truncated: false }),
    },
    missions: {
      plan: (req) => {
        const mission: Mission = {
          id: testId(),
          workspaceId: req.workspaceId,
          conversationId: req.conversationId,
          title: req.goal.slice(0, 60),
          goal: req.goal,
          mode: req.mode,
          state: "ready",
          modelId: req.modelId,
          createdAt: 1_500,
          startedAt: null,
          endedAt: null,
          updatedAt: 1_500,
        };
        const contract = makeContract(req.workspaceId, { mode: req.mode });
        const tasks: MissionTask[] = (
          seed.planTasks ?? [
            { title: "Reproduire le bug", acceptance: { kind: "test_passes", detail: "pnpm vitest run cart" } },
            { title: "Corriger", acceptance: { kind: "manual", detail: "" } },
          ]
        ).map((task, index) => ({ id: testId(), missionId: mission.id, seq: index + 1, state: "todo", ...task }));
        missions.set(mission.id, { mission, contract, tasks, events: [] });
        last = mission;
        return ok({
          mission,
          contract,
          tasks,
          summary: "Plan en deux étapes.",
          estimate: seed.planEstimate ?? { minUsd: 0.02, maxUsd: 0.1, assumptions: "4 à 10 appels" },
        });
      },
      start: ({ missionId, contract }) => {
        const entry = missions.get(missionId);
        if (!entry) return notFound("mission");
        entry.mission = { ...entry.mission, state: "running", startedAt: 1_600 };
        entry.contract = { ...entry.contract, ...contract };
        last = entry.mission;
        return ok(entry.mission);
      },
      pause: ({ missionId }) => {
        const entry = missions.get(missionId);
        if (!entry) return notFound("mission");
        entry.mission = { ...entry.mission, state: "suspended" };
        return ok(entry.mission);
      },
      resume: ({ missionId }) => {
        const entry = missions.get(missionId);
        if (!entry) return notFound("mission");
        entry.mission = { ...entry.mission, state: "running" };
        return ok(entry.mission);
      },
      stop: ({ missionId }) => {
        const entry = missions.get(missionId);
        if (!entry) return notFound("mission");
        entry.mission = { ...entry.mission, state: "cancelled", endedAt: 9_000 };
        return ok(entry.mission);
      },
      list: () => ok({ items: [...missions.values()].map((entry) => entry.mission), hasMore: false }),
      get: ({ missionId, afterSeq }) => {
        const entry = missions.get(missionId);
        if (!entry) return notFound("mission");
        const detail: MissionDetail = {
          mission: entry.mission,
          contract: entry.contract,
          tasks: entry.tasks,
          proofs: [],
          budget: makeBudget({ budgetUsd: entry.contract.budgetUsd }),
          events: entry.events.filter((event) => event.seq > afterSeq),
        };
        return ok(detail);
      },
      review: ({ decisions: list }) => {
        reviews.push(list);
        return ok({ applied: list, conflicts: [] });
      },
      // No checkpoint data in this fake: the mission's diff lists no file content.
      diff: ({ missionId }) => ok({ missionId, files: [] }),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    approvals: {
      list: ({ status }) => ok([...approvals.values()].filter((approval) => status === null || approval.status === status)),
      decide: ({ approvalId, decision, scope }) => {
        const approval = approvals.get(approvalId);
        if (!approval) return notFound("approval");
        decisions.push({ approvalId, decision, scope });
        const decided: Approval = {
          ...approval,
          status: decision === "approve" ? "approved" : "denied",
          scope: decision === "approve" ? scope : null,
          decidedAt: 3_000,
        };
        approvals.set(approvalId, decided);
        return ok(decided);
      },
    },
    permissions: {
      getProfile: () => ok(profile),
      setProfile: ({ profile: next }) => {
        profile = { ...profile, profile: next, showIsolationBanner: next === "autonomous" && profile.isolationLevel === "L0" };
        return ok(profile);
      },
    },
    checkpoints: {
      list: () => ok(seed.checkpoints ?? []),
      restoreFile: ({ checkpointId, path }) => ok({ status: "restored" as const, path, checkpointId }),
      restoreAll: ({ checkpointId }) => ok({ safetyCheckpointId: testId(), results: [{ status: "restored" as const, path: "a.ts", checkpointId }] }),
    },
    web: {
      getPolicy: () => ok(webPolicy),
      setPolicy: (req) => {
        webPolicy = {
          workspaceId: req.workspaceId,
          defaultAction: req.defaultAction,
          rules: req.rules.map((rule) => ({ id: testId(), ...rule, workspaceId: req.workspaceId, preset: req.preset })),
        };
        return ok(webPolicy);
      },
    },
  };

  return {
    overrides,
    emit,
    mission: () => last,
    workspace,
    decisions,
    reviews,
    approvals,
  };
}

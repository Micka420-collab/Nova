// `missions.*` IPC group (A1/A9/A11/A13): wires the mission controller (@nova/missions) to the
// SQLite repos, the provider proxy (key stays here), the tool registry over the other lanes'
// services (files/checkpoints/git L2, web L4, MCP L5, command runner), the permission engine and
// approvals of L1, and the agent-runtime worker over one MessagePort. Every controller refusal
// becomes a typed ServiceError. No Electron import here: the runtime port is injected
// (`openAgentRuntimePort` in workers/agent/main-port.ts), so this module is tested in Node.
import type { RuntimeLogger } from "@nova/agent-runtime";
import {
  MissionError,
  connectRuntime,
  createApprovalBridge,
  createMissionController,
  revertHunks,
  unifiedPatch,
  type ApprovalEventLike,
  type ApprovalServiceLike,
  type LoopContextHook,
  type LoopContinuationHook,
  type MissionController,
  type MissionControllerDeps,
  type MissionEventInput,
  type PermissionGate,
  type PortLike,
  type ReviewFsGate,
  type RuntimeLink,
  type ToolExecutionAudit,
  type ToolGatewayDeps,
} from "@nova/missions";
import type { ModelProvider } from "@nova/providers";
import {
  DEFAULT_DAILY_BUDGET_USD,
  type Checkpoint,
  type CheckpointReason,
  type CheckpointsListRequest,
  type IsolationLevel,
  type MissionDiff,
  type MissionDiffFile,
  type MissionEvent,
  type RelativePath,
  type RestoreFileResult,
} from "@nova/shared";
import { createMissionRepo, createWorkspaceRepo, type NovaStore } from "@nova/storage";
import { createToolRegistry, type McpToolOffer, type ToolDeps, type WorkspaceFileApi } from "@nova/tools";
import { decodeText, isWorkspaceError, readBytesOrNull, sha256 } from "@nova/workspace";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";
import { createProviderProxyHost, type ProviderProxyHost } from "./provider-proxy";

export interface MissionsServiceDeps {
  store: NovaStore;
  provider: Pick<ModelProvider, "streamChat">;
  resolveApiKey(): Promise<string | null>;
  /** Push to the renderer on IPC_CHANNELS.missionsEvent. */
  push(event: MissionEvent): void;
  /** Tool back-ends of one workspace (L2 file ops/facts/git, L4 web, L5 MCP, command runner). */
  toolDeps(workspaceId: string): Promise<ToolDeps>;
  /** Enabled MCP tools of the workspace (L5 `McpService.listToolsForModel`); default none. */
  mcpTools?(workspaceId: string): Promise<readonly McpToolOffer[]>;
  /** L1 `PermissionsService` (evaluates and audits every decision). */
  permissions: PermissionGate;
  /** L1 `ApprovalsService`; its `emit` must be wired to `service.onApprovalEvent`. */
  approvals: ApprovalServiceLike;
  /**
   * L2 checkpoints: `store.create` and `api.list`. Null disables writes and the review. In process,
   * `list` is not bound by the IPC's 500: the review reads every restore point of a mission.
   */
  checkpoints: {
    create(input: { workspaceId: string; missionId: string | null; label: string; reason: CheckpointReason }): Checkpoint;
    list(req: CheckpointsListRequest): Promise<Checkpoint[]>;
  } | null;
  /** Workspace operations of the review (see `createReviewFsGate`). */
  reviewFs: ReviewFsGate | null;
  /** Bytes for `missions.diff`: checkpoint objects and the file on disk now. Null: no diff. */
  diffFs: MissionDiffFs | null;
  isolationLevel(): IsolationLevel;
  /** L1 `AuditService.recordToolExecution`. */
  audit?(entry: ToolExecutionAudit): void;
  /** L1 `AuditService.recordDecision`, for mode refusals and owner rules (web policy, MCP) that decided. */
  auditDecision?: ToolGatewayDeps["auditDecision"];
  fallbackModelIds?(modelId: string): string[];
  dailyLimitUsd?: number;
  /** Bound on waiting for the runtime to end a stopped mission (controller default otherwise). */
  stopTimeoutMs?: number;
  /** A fresh port to the agent-runtime worker (production: `openAgentRuntimePort(workers)`). */
  openRuntimePort(): Promise<PortLike>;
  logger?: RuntimeLogger;
  /** J2-B L3: index of the skills enabled for a workspace (null = none, mission without skills). */
  skillIndex?: MissionControllerDeps["skillIndex"];
  /** J2-B L2: context preparation/observation of each model call (`ContextService.runtimeHook`). */
  contextHook?: LoopContextHook;
  /** J2-B L8: « jusqu'à preuve » rounds and the closing fact journaled before a terminal event. */
  continuation?: { hook: LoopContinuationHook; beforeTerminal(event: MissionEventInput): void };
  /**
   * J2-B L5: tool deps of ONE mission (a writing sub-mission works in its worktree). Default: the
   * workspace's deps.
   */
  routeToolDeps?(workspaceId: string, missionId: string, base: ToolDeps): Promise<ToolDeps>;
  /** J2-B L5: processes a mission runs outside its workspace runner (a sub-mission's worktree). */
  stopMissionProcesses?(missionId: string): Promise<void>;
  /**
   * J2-B L5: the worktree a writing sub-mission still works in (null once integrated or discarded).
   * Its review and diff would read and revert the PROJECT, so they wait for the integration.
   */
  missionRootOf?(missionId: string): Promise<string | null>;
}

export interface MissionsService {
  api: MainApi["missions"];
  controller: MissionController;
  host: ProviderProxyHost;
  /** Wire as L1 `ApprovalsService` `emit`. */
  onApprovalEvent(event: ApprovalEventLike): void;
}

export interface MissionDiffFs {
  /** Bytes of a checkpoint object (content before the mission). */
  readObject(hash: string): Promise<Uint8Array>;
  /** Current bytes of a workspace file; null when absent; `too_large` (unread) above `maxBytes`. */
  readCurrent(workspaceId: string, path: RelativePath, maxBytes: number): Promise<Uint8Array | null>;
}

/** Above this, a file's diff is not computed (the review offers the whole-file decision). */
const DIFF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A11: diff(before the mission → disk now) per file the mission wrote, with the SAME hunks
 * `revertHunks` undoes, so a hunk shown is the hunk reverted.
 */
async function missionFileDiff(
  fs: MissionDiffFs,
  workspaceId: string,
  file: { path: RelativePath; beforeHash: string | null },
): Promise<MissionDiffFile> {
  let before: Uint8Array | null;
  let current: Uint8Array | null;
  try {
    // The current file is sized before it is read: a big one is never loaded just to be skipped.
    current = await fs.readCurrent(workspaceId, file.path, DIFF_MAX_BYTES);
    before = file.beforeHash === null ? null : await fs.readObject(file.beforeHash);
  } catch (error) {
    const missing = isWorkspaceError(error) && error.code === "too_large" ? "too_large" : "unreadable";
    return { path: file.path, change: "modified", beforeHash: file.beforeHash, currentHash: null, patch: null, missing };
  }
  const currentHash = current === null ? null : sha256(current);
  const change = before === null ? "created" : current === null ? "deleted" : "modified";
  const base = { path: file.path, change, beforeHash: file.beforeHash, currentHash } as const;
  if ((before?.byteLength ?? 0) > DIFF_MAX_BYTES || (current?.byteLength ?? 0) > DIFF_MAX_BYTES) {
    return { ...base, patch: null, missing: "too_large" };
  }
  const beforeText = before === null ? null : decodeText(before);
  const currentText = current === null ? null : decodeText(current);
  if ((before !== null && beforeText === null) || (current !== null && currentText === null)) {
    return { ...base, patch: null, missing: "binary" };
  }
  const patch = unifiedPatch(file.path, beforeText, currentText);
  if (patch === null) return { ...base, patch: null, missing: "too_large" };
  return patch === "" ? { ...base, patch: null, missing: "no_change" } : { ...base, patch, missing: null };
}

function toServiceError(error: unknown): unknown {
  if (error instanceof MissionError) return new ServiceError(error.code, error.message);
  return error;
}

export function createMissionsService(deps: MissionsServiceDeps): MissionsService {
  const missions = createMissionRepo(deps.store.db);
  const workspaces = createWorkspaceRepo(deps.store.db);
  const model = (modelId: string) => deps.store.loadCatalog("openrouter")?.models.find((info) => info.id === modelId) ?? null;
  let link: RuntimeLink | null = null;
  let linking: Promise<RuntimeLink> | null = null;

  // Late-bound: the controller needs the host's proxy and the host needs the controller's budget.
  let controller: MissionController | null = null;
  const controllerOf = (): MissionController => {
    if (!controller) throw new Error("missions controller not ready");
    return controller;
  };
  const budget: MissionController["budget"] = {
    reserve: (missionId, estimate) => controllerOf().budget.reserve(missionId, estimate),
    settle: (missionId, reservationId, report) => controllerOf().budget.settle(missionId, reservationId, report),
    release: (missionId, reservationId) => controllerOf().budget.release(missionId, reservationId),
  };

  const host = createProviderProxyHost({
    provider: deps.provider,
    resolveApiKey: deps.resolveApiKey,
    dataCollection: () => deps.store.getSettings().privacy.providerDataCollection,
    model,
    budget,
    ...(deps.fallbackModelIds ? { fallbackModelIds: deps.fallbackModelIds } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  const bridge = createApprovalBridge({
    approvals: deps.approvals,
    journal: { append: (event) => controllerOf().journal.append(event) },
  });

  const checkpoints = deps.checkpoints;
  controller = createMissionController({
    store: missions,
    push: deps.push,
    proxy: host.proxy,
    async runtime() {
      if (link) return link;
      linking ??= (async () => {
        const port = await deps.openRuntimePort();
        const next = connectRuntime(port, {
          ...controllerOf().runtimeHandlers(host.streamModel),
          ...(deps.contextHook ? { context: deps.contextHook } : {}),
          ...(deps.continuation ? { continuation: deps.continuation.hook } : {}),
        });
        link = next;
        void next.closed.then(() => {
          if (link === next) link = null;
        });
        return next;
      })().finally(() => {
        linking = null;
      });
      return linking;
    },
    workspaces: {
      get: (id) => {
        const workspace = workspaces.get(id);
        return workspace ? { id: workspace.id, permissionProfile: workspace.permissionProfile } : null;
      },
    },
    facts: async (workspaceId) => (await deps.toolDeps(workspaceId)).facts(),
    async tools({ workspaceId, missionId }) {
      const mcpTools = (await deps.mcpTools?.(workspaceId).catch(() => [])) ?? [];
      const base = await deps.toolDeps(workspaceId);
      const routed = deps.routeToolDeps ? await deps.routeToolDeps(workspaceId, missionId, base) : base;
      return { registry: createToolRegistry({ deps: routed, mcpTools }), mcpTools };
    },
    commands: {
      // Background processes live in the workspace's runner (or a sub-mission's); stop them wherever they run.
      stopAll: async (missionId) => {
        const record = missions.get(missionId);
        if (record) await (await deps.toolDeps(record.workspaceId)).commands?.stopAll(missionId);
        await deps.stopMissionProcesses?.(missionId);
      },
    },
    ...(deps.skillIndex ? { skillIndex: deps.skillIndex } : {}),
    ...(deps.continuation ? { beforeTerminal: deps.continuation.beforeTerminal } : {}),
    permissions: deps.permissions,
    approvals: bridge.gate,
    checkpoints: checkpoints
      ? {
          create: (input) => checkpoints.create(input),
          list: (req) => checkpoints.list(req),
        }
      : null,
    reviewFs: deps.reviewFs,
    isolationLevel: deps.isolationLevel,
    pricing: (modelId) => model(modelId)?.pricing ?? null,
    supportsTools: (modelId) => model(modelId)?.supportsTools ?? null,
    dailyLimitUsd: deps.dailyLimitUsd ?? DEFAULT_DAILY_BUDGET_USD,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.auditDecision ? { auditDecision: deps.auditDecision } : {}),
    ...(deps.stopTimeoutMs !== undefined ? { stopTimeoutMs: deps.stopTimeoutMs } : {}),
  });
  const ready = controller;

  const guard =
    <A, R>(fn: (arg: A) => Promise<R>) =>
    async (arg: A): Promise<R> => {
      try {
        return await fn(arg);
      } catch (error) {
        throw toServiceError(error);
      }
    };

  /** A writing sub-mission not yet integrated: its changes live in its worktree, not the project. */
  const notIntegratedYet = async (missionId: string): Promise<void> => {
    if (deps.missionRootOf && (await deps.missionRootOf(missionId)) !== null) {
      throw new ServiceError("conflict", "this sub-mission's changes are reviewed once integrated into the project");
    }
  };

  return {
    controller: ready,
    host,
    onApprovalEvent: (event) => bridge.onEvent(event),
    api: {
      plan: guard(ready.plan),
      start: guard(ready.start),
      pause: guard(ready.pause),
      resume: guard(ready.resume),
      stop: guard(ready.stop),
      list: guard(ready.list),
      get: guard(ready.get),
      review: guard(async (req) => {
        await notIntegratedYet(req.missionId);
        return ready.review(req);
      }),
      diff: guard(async ({ missionId }): Promise<MissionDiff> => {
        await notIntegratedYet(missionId);
        const record = missions.get(missionId);
        if (!record) throw new ServiceError("not_found", "Mission not found");
        const fs = deps.diffFs;
        if (!fs) return { missionId, files: [] };
        const review = await ready.reviewModel(missionId);
        // One file at a time: each may hold up to two DIFF_MAX_BYTES buffers plus its diff.
        const files: MissionDiffFile[] = [];
        for (const file of review.files) files.push(await missionFileDiff(fs, record.workspaceId, file));
        return { missionId, files };
      }),
    },
  };
}

export interface ReviewFsDeps {
  rootOf(workspaceId: string): Promise<string>;
  /** L2 `checkpointsService.api.restoreFile` (refuses when the user changed the file since). */
  restoreFile(req: { checkpointId: string; path: RelativePath }): Promise<RestoreFileResult>;
  /** Bytes of a checkpoint object (`createObjectStore(checkpointObjectsDir(dataDir)).get`). */
  readObject(hash: string): Promise<Uint8Array>;
  /** Agent file API of the workspace (L2 `filesService.fileOpsFor`): checkpointed, hash-checked writes. */
  fileOps(workspaceId: string): Promise<Pick<WorkspaceFileApi, "writeFile">>;
  createCheckpoint(input: { workspaceId: string; missionId: string | null; label: string; reason: CheckpointReason }): Checkpoint;
}

/**
 * A11 review operations over L2: current hash from disk, whole-file restore through the
 * checkpoints, and per-hunk revert = inverse of the chosen hunks of diff(before mission → now),
 * written through the agent file API with its own restore point (nothing is lost, even a revert).
 */
export function createReviewFsGate(deps: ReviewFsDeps): ReviewFsGate {
  const readCurrent = async (workspaceId: string, path: RelativePath): Promise<{ bytes: Uint8Array; hash: string } | null> => {
    const bytes = await readBytesOrNull(await deps.rootOf(workspaceId), path);
    return bytes === null ? null : { bytes, hash: sha256(bytes) };
  };
  return {
    async currentHash(workspaceId, path) {
      return (await readCurrent(workspaceId, path))?.hash ?? null;
    },
    restoreFile: (checkpointId, path) => deps.restoreFile({ checkpointId, path }),
    async revertHunks(input) {
      const current = await readCurrent(input.workspaceId, input.path);
      if (!current || current.hash !== input.expectedCurrentHash) return { status: "conflict" };
      const currentText = decodeText(current.bytes);
      const baseText = input.baseHash === null ? "" : decodeText(await deps.readObject(input.baseHash));
      if (currentText === null || baseText === null) return { status: "conflict" };
      const next = revertHunks(baseText, currentText, input.hunkIndexes);
      if (next === null) return { status: "conflict" };
      const checkpoint = deps.createCheckpoint({
        workspaceId: input.workspaceId,
        missionId: input.missionId,
        label: `Revue : ${input.path}`,
        reason: "before_restore",
      });
      const files = await deps.fileOps(input.workspaceId);
      const outcome = await files.writeFile(input.path, next, { expectedHash: current.hash, checkpointId: checkpoint.id });
      return outcome.status === "written" ? { status: "reverted" } : { status: "conflict" };
    },
  };
}

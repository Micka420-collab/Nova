// `missions.*` IPC group (A1/A9/A11/A13): wires the mission controller (@nova/missions) to the
// SQLite repos, the provider proxy (key stays here), the tool registry over the injected APIs,
// the permission/approval/checkpoint gates of the other lanes, and the agent-runtime worker over
// one MessagePort. Every controller refusal becomes a typed ServiceError.
import { MessageChannelMain } from "electron";
import type { RuntimeLogger } from "@nova/agent-runtime";
import {
  MissionError,
  connectRuntime,
  createMissionController,
  type ApprovalGate,
  type CheckpointGate,
  type MissionController,
  type PermissionGate,
  type PortLike,
  type ReviewFsGate,
  type RuntimeLink,
} from "@nova/missions";
import type { ModelProvider } from "@nova/providers";
import {
  DEFAULT_DAILY_BUDGET_USD,
  type Checkpoint,
  type CheckpointsListRequest,
  type IsolationLevel,
  type McpToolInfo,
  type MissionEvent,
} from "@nova/shared";
import { createMissionRepo, createWorkspaceRepo, type NovaStore } from "@nova/storage";
import { createToolRegistry, type ToolDeps } from "@nova/tools";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";
import type { WorkerPool } from "../workers";
import { portFromMessagePortMain } from "../../workers/agent/electron-port";
import { createProviderProxyHost, type ProviderProxyHost } from "./provider-proxy";

export interface MissionsServiceDeps {
  store: NovaStore;
  provider: Pick<ModelProvider, "streamChat">;
  resolveApiKey(): Promise<string | null>;
  /** Push to the renderer on IPC_CHANNELS.missionsEvent. */
  push(event: MissionEvent): void;
  /** Tool back-ends (L2 fs/git, L4 web, L5 mcp, command runner) for a workspace. */
  toolDeps(workspaceId: string): ToolDeps;
  /** Enabled MCP tools of the workspace (L5); default none. */
  mcpTools?(workspaceId: string): Promise<McpToolInfo[]>;
  permissions: PermissionGate;
  approvals: ApprovalGate;
  checkpoints: (CheckpointGate & { list(req: CheckpointsListRequest): Promise<Checkpoint[]> }) | null;
  reviewFs: ReviewFsGate | null;
  isolationLevel(): IsolationLevel;
  audit?: Parameters<typeof createMissionController>[0]["audit"];
  fallbackModelIds?(modelId: string): string[];
  dailyLimitUsd?: number;
  /**
   * The agent-runtime link. Default: the `agent-runtime` worker of the pool with a fresh
   * MessageChannelMain; tests pass an in-memory port.
   */
  runtimePort?: () => Promise<PortLike>;
  workers?: Pick<WorkerPool, "get">;
  logger?: RuntimeLogger;
}

export interface MissionsService {
  api: MainApi["missions"];
  controller: MissionController;
  host: ProviderProxyHost;
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

  const openPort = async (): Promise<PortLike> => {
    if (deps.runtimePort) return deps.runtimePort();
    if (!deps.workers) throw new ServiceError("unavailable", "agent runtime not configured");
    const { port1, port2 } = new MessageChannelMain();
    await deps.workers.get("agent-runtime").request("channel.attach", null, [port1]);
    return portFromMessagePortMain(port2);
  };

  // Late-bound: the controller needs the host's budget gate and the host needs the controller.
  let controller: MissionController | null = null;
  const budget: MissionController["budget"] = {
    reserve: (missionId, estimate) => controllerOf().budget.reserve(missionId, estimate),
    settle: (missionId, reservationId, report) => controllerOf().budget.settle(missionId, reservationId, report),
    release: (missionId, reservationId) => controllerOf().budget.release(missionId, reservationId),
  };
  const controllerOf = (): MissionController => {
    if (!controller) throw new Error("missions controller not ready");
    return controller;
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

  controller = createMissionController({
    store: missions,
    push: deps.push,
    proxy: host.proxy,
    async runtime() {
      if (link) return link;
      linking ??= (async () => {
        const port = await openPort();
        const next = connectRuntime(port, controllerOf().runtimeHandlers(host.streamModel));
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
    facts: (workspaceId) => deps.toolDeps(workspaceId).fs.facts({ workspaceId, refresh: false }),
    async tools({ workspaceId }) {
      const mcpTools = (await deps.mcpTools?.(workspaceId).catch(() => [])) ?? [];
      return { registry: createToolRegistry({ deps: deps.toolDeps(workspaceId), mcpTools }), mcpTools };
    },
    commands: {
      // Background processes are owned per workspace runner; stop them wherever they run.
      stopAll: async (missionId) => {
        const record = missions.get(missionId);
        if (record) await deps.toolDeps(record.workspaceId).commands?.stopAll(missionId);
      },
    },
    permissions: deps.permissions,
    approvals: deps.approvals,
    checkpoints: deps.checkpoints,
    reviewFs: deps.reviewFs,
    isolationLevel: deps.isolationLevel,
    pricing: (modelId) => model(modelId)?.pricing ?? null,
    supportsTools: (modelId) => model(modelId)?.supportsTools ?? null,
    dailyLimitUsd: deps.dailyLimitUsd ?? DEFAULT_DAILY_BUDGET_USD,
    ...(deps.audit ? { audit: deps.audit } : {}),
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

  return {
    controller: ready,
    host,
    api: {
      plan: guard(ready.plan),
      start: guard(ready.start),
      pause: guard(ready.pause),
      resume: guard(ready.resume),
      stop: guard(ready.stop),
      list: guard(ready.list),
      get: guard(ready.get),
      review: guard(ready.review),
    },
  };
}

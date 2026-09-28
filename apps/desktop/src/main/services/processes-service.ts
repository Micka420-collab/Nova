// L1 — background processes of missions and the agent terminal (J2-B lane map).
// Owns the main-process command runner of the agent tools and plugs it into the pty-host:
// - `runner`: `ToolDeps.commands` (run_command / run_tests). Background processes run in a
//   read-only agent terminal session (L0: argv without a shell, scrubbed env, confined cwd);
//   foreground commands keep the structured execution and are mirrored in one agent session per
//   mission. Without a pty (node-pty unavailable), background processes run as plain children.
// - `tools`: `ToolDeps.processes` (process_list / process_output / process_stop), scoped to the
//   calling mission: another mission's process is `null` (the tool answers `not_found`).
// - `api`: the `processes.*` IPC group (the user sees and stops the processes of every mission).
// - `process.ended` is journaled on the mission (accepted after its terminal event), and every
//   ProcessEvent is pushed to the renderer through `onEvent`;
// - « Prendre la main » (a session updated to owner `user`) hands the process over: it ends for the
//   mission (`handed_over`, journaled), and the mission's end no longer kills the user's session.
import type { MissionProcess, ProcessEvent } from "@nova/shared";
import type { MissionEventInput } from "@nova/missions";
import { createProcessCommandRunner, type ProcessApi, type ProcessCommandRunner, type ProcessCommandRunnerOptions } from "@nova/tools";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";
import type { TerminalService } from "./terminal-service";

type ProcessesApi = MainApi["processes"];
/** `@nova/tools` AgentTerminalHost (derived: the package index does not export it yet). */
type AgentTerminalHost = NonNullable<ProcessCommandRunnerOptions["terminal"]>;

export interface ProcessesLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ProcessesServiceDeps {
  /** Absolute cwd for a workspace-relative path, or null when it escapes the root (S2). */
  resolveCwd(workspaceId: string, cwd: string): Promise<string | null>;
  /** The terminal service (pty-host); null = no agent terminal (plain child processes). */
  terminal: Pick<TerminalService, "startAgentProcess" | "stopSession" | "openMirror" | "writeMirror" | "closeMirror" | "onEvent"> | null;
  /** The missions journal (`missions.controller.journal`). */
  journal: { append(event: Extract<MissionEventInput, { type: "process.ended" }>): unknown };
  /** Title of the mirror session of a mission's commands (French UI copy, chosen by the wiring). */
  mirrorTitle: string;
  logger?: ProcessesLogger;
  /** Tests: environment, platform and timings of the runner. */
  runnerOptions?: {
    env?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
    killGraceMs?: number;
    backgroundSettleMs?: number;
  };
}

export interface ProcessesService {
  /** `ToolDeps.commands`. */
  runner: ProcessCommandRunner;
  /** `ToolDeps.processes`. */
  tools: ProcessApi;
  /** `harness.processes` (main pushes events itself, through `onEvent` below). */
  api: ProcessesApi;
  /** Push to the renderer (`IPC_CHANNELS.processesEvent`). */
  onEvent(listener: (event: ProcessEvent) => void): () => void;
  /** At quit: every agent process tree is killed (no orphan) and new launches are refused. */
  stopEverything(): Promise<void>;
}

/** The pty-host as the runner's agent terminal (redacted titles and data come from the runner). */
function terminalHost(terminal: NonNullable<ProcessesServiceDeps["terminal"]>, mirrorTitle: string): AgentTerminalHost {
  return {
    async startProcess(request, handlers) {
      const started = await terminal.startAgentProcess(
        {
          workspaceId: request.workspaceId,
          missionId: request.missionId,
          cwd: request.cwd,
          command: request.program,
          env: request.env,
          title: request.title,
        },
        { onData: handlers.onData, onExit: (exitCode, signal) => handlers.onExit({ exitCode, signal }) },
      );
      return started ? { sessionId: started.session.id, pid: started.pid } : null;
    },
    stopProcess: (sessionId) => terminal.stopSession(sessionId),
    async openMirror(request) {
      const session = await terminal.openMirror({ ...request, title: mirrorTitle });
      return session.id;
    },
    writeMirror: (sessionId, data) => terminal.writeMirror(sessionId, data),
    closeMirror: (sessionId, exitCode) => terminal.closeMirror(sessionId, exitCode),
  };
}

function describeError(error: unknown): string {
  if (error instanceof ServiceError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}

export function createProcessesService(deps: ProcessesServiceDeps): ProcessesService {
  const runner = createProcessCommandRunner({
    resolveCwd: deps.resolveCwd,
    terminal: deps.terminal ? terminalHost(deps.terminal, deps.mirrorTitle) : null,
    // The command itself is unaffected; only its display in the dock is missing.
    onTerminalError: (error) => deps.logger?.warn("agent terminal mirror failed", { error: describeError(error) }),
    ...deps.runnerOptions,
  });
  const listeners = new Set<(event: ProcessEvent) => void>();
  runner.onProcessEvent((event) => {
    if (event.type === "process.ended") deps.journal.append({ type: "process.ended", missionId: event.process.missionId, process: event.process });
    for (const listener of listeners) listener(event);
  });
  // « Prendre la main » hands an agent session to the user: its process leaves the mission.
  deps.terminal?.onEvent((event) => {
    if (event.type === "session.updated" && event.session.owner === "user") runner.handOver(event.session.id);
  });

  /** The process when it belongs to `missionId`; null otherwise (unknown and foreign look the same). */
  const ofMission = (missionId: string, processId: string): MissionProcess | null => {
    const process = runner.process(processId);
    return process && process.missionId === missionId ? process : null;
  };

  const known = (processId: string): MissionProcess => {
    const process = runner.process(processId);
    if (!process) throw new ServiceError("not_found", "Process not found");
    return process;
  };

  const tools: ProcessApi = {
    list: (missionId) => runner.processes({ workspaceId: null, missionId }),
    output: (missionId, processId, maxChars) => (ofMission(missionId, processId) ? runner.output(processId, maxChars) : null),
    async stop(missionId, processId) {
      if (!ofMission(missionId, processId)) return null;
      await runner.stop(processId);
      return runner.process(processId);
    },
  };

  const api: ProcessesApi = {
    list: async (req) => runner.processes({ workspaceId: req.workspaceId, missionId: req.missionId }),
    output: async (req) => {
      known(req.processId);
      const output = runner.output(req.processId, req.maxChars);
      if (!output) throw new ServiceError("not_found", "Process not found");
      return output;
    },
    stop: async (req) => {
      known(req.processId);
      await runner.stop(req.processId);
      // Forgotten meanwhile (only the oldest ended records are): it ended, which is what was asked.
      return known(req.processId);
    },
  };

  return {
    runner,
    tools,
    api,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopEverything: () => runner.stopEverything(),
  };
}

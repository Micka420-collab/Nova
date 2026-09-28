// J2-B L1: background processes started by a mission (run_command `background: true`) and the
// agent terminal. Processes are owned by main's command runner; their output is kept in a bounded
// ring (never stored in SQLite) and can be mirrored read-only in a pty-host agent session
// ("Prendre la main" hands the session to the user). Agent tools: process_list, process_output,
// process_stop — evaluated by the permission engine like every other tool.
import { z } from "zod";
import { EntityIdSchema } from "./ids";
import type { RelativePath } from "./paths";

export type MissionProcessState = "running" | "exited" | "stopped";

export interface MissionProcess {
  /** Command-runner process id (uuid). */
  id: string;
  missionId: string;
  workspaceId: string;
  /** Exact argv that runs (redacted for display by the producer). */
  argv: string[];
  cwd: RelativePath;
  pid: number | null;
  state: MissionProcessState;
  /** null while running, or when the exit was not observed (host died). */
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Agent terminal mirroring this process (read-only until taken over); null = none. */
  terminalSessionId: string | null;
  /** Characters produced so far (the ring keeps the last PROCESS_LIMITS.outputRingChars). */
  outputChars: number;
}

export interface ProcessOutput {
  processId: string;
  state: MissionProcessState;
  /** Last characters of combined stdout/stderr, redacted (`redactSecrets`). */
  text: string;
  /** Older output was dropped from the ring. */
  truncated: boolean;
  totalChars: number;
}

export const PROCESS_LIMITS = {
  /** Output kept in memory per process (older characters are dropped). */
  outputRingChars: 200_000,
  /** Largest tail returned by process_output / processes.output. */
  outputTailMaxChars: 20_000,
  /** Background processes one mission may keep running at once. */
  maxRunningPerMission: 8,
} as const;

export const ProcessesListRequestSchema = z.object({
  workspaceId: EntityIdSchema.nullable(),
  /** null = every mission of the workspace (or of every workspace). */
  missionId: EntityIdSchema.nullable(),
});
export const ProcessIdRequestSchema = z.object({ processId: EntityIdSchema });
export const ProcessOutputRequestSchema = z.object({
  processId: EntityIdSchema,
  maxChars: z.int().min(1).max(PROCESS_LIMITS.outputTailMaxChars),
});
export type ProcessesListRequest = z.infer<typeof ProcessesListRequestSchema>;
export type ProcessIdRequest = z.infer<typeof ProcessIdRequestSchema>;
export type ProcessOutputRequest = z.infer<typeof ProcessOutputRequestSchema>;

/** Pushed on `processes.onEvent`. */
export type ProcessEvent =
  | { type: "process.started"; process: MissionProcess }
  | { type: "process.updated"; process: MissionProcess }
  | { type: "process.ended"; process: MissionProcess };

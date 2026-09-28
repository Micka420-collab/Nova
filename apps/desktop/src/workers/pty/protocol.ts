// Methods of the pty-host worker (main → pty-host over the worker protocol, see ../protocol.ts).
// Main resolves the workspace root; the host re-confines the cwd itself before spawning (S2).
// Data never goes through these methods: `create` and `attach` carry a MessagePort (transfer) that
// the renderer then uses directly (packages/shared/src/terminal.ts).
//
// J2-B L1 agent terminal: `startAgent` runs a mission's background program (argv, no shell,
// scrubbed env + checked extras) in a read-only session whose output is ALSO streamed to main
// (`terminal.data`, for the process output ring); `mirror.*` sessions have no process at all: main
// writes the structured commands it runs into them (read-only, never taken over).
import { z } from "zod";
import { RelativePathSchema, SECRET_ENV_NAME, type TerminalSession } from "@nova/shared";

export const PTY_METHODS = {
  create: "terminal.create",
  list: "terminal.list",
  attach: "terminal.attach",
  resize: "terminal.resize",
  kill: "terminal.kill",
  takeOver: "terminal.takeOver",
  /** Agent program session streamed to main (returns `PtyAgentStarted`). */
  startAgent: "terminal.startAgent",
  /** Ends the session's process tree; unlike `kill`, the session stays listed (ended). */
  stop: "terminal.stop",
  mirrorOpen: "terminal.mirror.open",
  mirrorWrite: "terminal.mirror.write",
  mirrorClose: "terminal.mirror.close",
} as const;

/** Worker → main events. */
export const PTY_EVENTS = {
  /**
   * A session's process ended (params: `PtyExitNotice`: TerminalSession & { outputTail, signal },
   * tail redacted).
   */
  exit: "terminal.exit",
  /** Output of a streamed agent session (params: `PtyDataNotice`), coalesced like the port output. */
  data: "terminal.data",
  /** A session changed owner or title (params: TerminalSession). */
  update: "terminal.update",
} as const;

const cols = z.int().min(2).max(1_000);
const rows = z.int().min(1).max(500);
const id = z.uuid();

/** Program run in place of the user's shell (agent sessions). Never interpreted by a shell. */
export const PtyCommandSchema = z.object({
  file: z.string().min(1).max(4_096),
  args: z.array(z.string().max(32_768)).max(1_000),
});

export const PtyCreateParamsSchema = z.object({
  id,
  workspaceId: id,
  /** Absolute realpath of the workspace root, chosen by main. */
  root: z.string().min(1).max(4_096),
  cwd: RelativePathSchema,
  cols,
  rows,
  owner: z.enum(["user", "agent"]),
  missionId: id.nullable(),
  title: z.string().min(1).max(200).nullable(),
  command: PtyCommandSchema.nullable(),
});
export const PtyListParamsSchema = z.object({ workspaceId: id.nullable() });
export const PtySessionParamsSchema = z.object({ sessionId: id });
export const PtyResizeParamsSchema = z.object({ sessionId: id, cols, rows });

/** Extra environment of an agent program: plain names, never a secret-looking one. */
const ExtraEnvSchema = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(32_768))
  .refine((env) => Object.keys(env).length <= 64 && Object.keys(env).every((name) => !SECRET_ENV_NAME.test(name)), "invalid environment");

export const PtyAgentStartParamsSchema = z.object({
  id,
  workspaceId: id,
  root: z.string().min(1).max(4_096),
  cwd: RelativePathSchema,
  cols,
  rows,
  missionId: id,
  title: z.string().min(1).max(200),
  /** `verbatim` (Windows only): `args` joined is the exact command line (cmd.exe running a batch shim). */
  command: PtyCommandSchema.extend({ verbatim: z.boolean() }),
  env: ExtraEnvSchema,
});

export const PtyMirrorOpenParamsSchema = z.object({
  id,
  workspaceId: id,
  root: z.string().min(1).max(4_096),
  cwd: RelativePathSchema,
  cols,
  rows,
  missionId: id,
  title: z.string().min(1).max(200),
});
export const PtyMirrorWriteParamsSchema = z.object({ sessionId: id, data: z.string().max(1_000_000) });
export const PtyMirrorCloseParamsSchema = z.object({ sessionId: id, exitCode: z.int().nullable() });

export type PtyCommand = z.infer<typeof PtyCommandSchema>;
export type PtyAgentStartParams = z.infer<typeof PtyAgentStartParamsSchema>;
export type PtyMirrorOpenParams = z.infer<typeof PtyMirrorOpenParamsSchema>;
export type PtyMirrorWriteParams = z.infer<typeof PtyMirrorWriteParamsSchema>;
export type PtyMirrorCloseParams = z.infer<typeof PtyMirrorCloseParamsSchema>;

export interface PtyAgentStarted {
  session: TerminalSession;
  pid: number;
}
export type PtyExitNotice = TerminalSession & { outputTail: string; signal: string | null };
export interface PtyDataNotice {
  sessionId: string;
  data: string;
}
export type PtyCreateParams = z.infer<typeof PtyCreateParamsSchema>;
export type PtyListParams = z.infer<typeof PtyListParamsSchema>;
export type PtySessionParams = z.infer<typeof PtySessionParamsSchema>;
export type PtyResizeParams = z.infer<typeof PtyResizeParamsSchema>;
export type { TerminalSession };

// Methods of the pty-host worker (main → pty-host over the worker protocol, see ../protocol.ts).
// Main resolves the workspace root; the host re-confines the cwd itself before spawning (S2).
// Data never goes through these methods: `create` and `attach` carry a MessagePort (transfer) that
// the renderer then uses directly (packages/shared/src/terminal.ts).
import { z } from "zod";
import { RelativePathSchema, type TerminalSession } from "@nova/shared";

export const PTY_METHODS = {
  create: "terminal.create",
  list: "terminal.list",
  attach: "terminal.attach",
  resize: "terminal.resize",
  kill: "terminal.kill",
  takeOver: "terminal.takeOver",
} as const;

/** Worker → main events. */
export const PTY_EVENTS = {
  /** A session's process ended (params: TerminalSession). */
  exit: "terminal.exit",
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

export type PtyCommand = z.infer<typeof PtyCommandSchema>;
export type PtyCreateParams = z.infer<typeof PtyCreateParamsSchema>;
export type PtyListParams = z.infer<typeof PtyListParamsSchema>;
export type PtySessionParams = z.infer<typeof PtySessionParamsSchema>;
export type PtyResizeParams = z.infer<typeof PtyResizeParamsSchema>;
export type { TerminalSession };

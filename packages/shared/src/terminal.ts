// Integrated terminal (E13): node-pty sessions owned by the pty-host utilityProcess.
//
// Control goes through IPC (create/list/attach/resize/kill). DATA never goes through ipcMain: on
// `create` and `attach`, main creates a MessageChannelMain, gives one port to the pty-host and
// transfers the other to the renderer (see ./ports for the preload relay). The renderer then
// exchanges `TerminalPortMessage`s directly with the pty-host.
//
// Backpressure (credit window): the host sends `output`; the renderer acks the characters it has
// rendered (`ack`). The host pauses the pty when unacked output exceeds TERMINAL_FLOW.highWatermark
// and resumes below TERMINAL_FLOW.lowWatermark, so `yes` or a 100 000-line build never freezes the UI.
import { z } from "zod";
import { EntityIdSchema } from "./ids";
import { RelativePathSchema, type RelativePath } from "./paths";

export type TerminalOwner = "user" | "agent";

export interface TerminalSession {
  id: string;
  workspaceId: string;
  cwd: RelativePath;
  /** Shell or program name (e.g. `bash`, `zsh`, `pwsh`), not a path. */
  shell: string;
  title: string;
  /** Agent sessions display the mission's commands (read-only mirror, execution stays structured — A3). */
  owner: TerminalOwner;
  missionId: string | null;
  cols: number;
  rows: number;
  state: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
}

const cols = z.int().min(2).max(1_000);
const rows = z.int().min(1).max(500);

/** User terminals only; agent terminals are created by the mission runtime. */
export const TerminalCreateRequestSchema = z.object({
  workspaceId: EntityIdSchema,
  cwd: RelativePathSchema,
  cols,
  rows,
});
export const TerminalSessionRequestSchema = z.object({ sessionId: EntityIdSchema });
export const TerminalResizeRequestSchema = z.object({ sessionId: EntityIdSchema, cols, rows });
export const TerminalListRequestSchema = z.object({ workspaceId: EntityIdSchema.nullable() });
/** Pushed on `terminal.onEvent`: sessions created (agent ones included), updated or exited. */
export type TerminalEvent =
  | { type: "session.created"; session: TerminalSession }
  | { type: "session.updated"; session: TerminalSession }
  | { type: "session.exited"; session: TerminalSession };

export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;
export type TerminalSessionRequest = z.infer<typeof TerminalSessionRequestSchema>;
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;
export type TerminalListRequest = z.infer<typeof TerminalListRequestSchema>;

export const TERMINAL_FLOW = {
  highWatermark: 100_000,
  lowWatermark: 10_000,
  /** Scrollback replayed on attach (characters). */
  replayMaxChars: 200_000,
} as const;

/** renderer → pty-host, over the session's MessagePort. */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  /** Characters of `output` the renderer has written to xterm.js. */
  | { type: "ack"; chars: number };

/** pty-host → renderer, over the session's MessagePort. */
export type TerminalHostMessage =
  /** Sent once right after attach: recent scrollback, so a reloaded window gets its screen back. */
  | { type: "replay"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null; signal: number | null };

export type TerminalPortMessage = TerminalClientMessage | TerminalHostMessage;

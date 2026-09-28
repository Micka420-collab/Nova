// Renderer end of a terminal session's MessagePort (protocol: packages/shared/src/terminal.ts).
// Output is written to xterm and acked only once xterm has parsed it (`write` callback): that ack is
// the credit the pty-host waits for before sending more, so a flood (`yes`, a 100 000-line build)
// is paced by the real rendering speed and never piles up in the renderer.
import type { TerminalHostMessage } from "@nova/shared";

export interface TerminalWriter {
  write(data: string, callback: () => void): void;
}

export interface TerminalExit {
  exitCode: number | null;
  signal: number | null;
}

export interface TerminalClientHandlers {
  onExit(exit: TerminalExit): void;
}

/** The subset of a DOM MessagePort the client uses. */
export type ClientPort = Pick<MessagePort, "postMessage" | "start" | "close"> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

function isHostMessage(value: unknown): value is TerminalHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] === "output" || record["type"] === "replay") return typeof record["data"] === "string";
  if (record["type"] === "exit") {
    const code = record["exitCode"];
    const signal = record["signal"];
    return (code === null || typeof code === "number") && (signal === null || typeof signal === "number");
  }
  return false;
}

export class TerminalPortClient {
  private disposed = false;

  constructor(
    private readonly port: ClientPort,
    private readonly writer: TerminalWriter,
    private readonly handlers: TerminalClientHandlers,
  ) {
    port.onmessage = (event) => this.onMessage(event.data);
    port.start();
  }

  /** Keystrokes and pastes, sent as they come (no coalescing: echo latency matters). */
  input(data: string): void {
    if (!this.disposed && data.length > 0) this.port.postMessage({ type: "input", data });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.onmessage = null;
    this.port.close();
  }

  private onMessage(message: unknown): void {
    if (this.disposed || !isHostMessage(message)) return;
    if (message.type === "exit") {
      this.handlers.onExit({ exitCode: message.exitCode, signal: message.signal });
      return;
    }
    const chars = message.data.length;
    if (chars === 0) return;
    this.writer.write(message.data, () => {
      if (!this.disposed) this.port.postMessage({ type: "ack", chars });
    });
  }
}

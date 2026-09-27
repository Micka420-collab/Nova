// Relay of runtime chat events to the window, with a way to await the end of a stream.
import type { ChatStreamEvent } from "@nova/shared";

const TERMINAL_TYPES: ReadonlySet<ChatStreamEvent["type"]> = new Set(["completed", "stopped", "failed"]);

export class ChatEventHub {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly forward: (event: ChatStreamEvent) => void) {}

  /** Runner `emit`: the terminal event is emitted after the runner persisted the outcome. */
  readonly emit = (event: ChatStreamEvent): void => {
    try {
      this.forward(event);
    } finally {
      if (TERMINAL_TYPES.has(event.type)) {
        for (const done of [...(this.waiters.get(event.streamId) ?? [])]) done();
      }
    }
  };

  /**
   * Resolves on the stream's terminal event, or after `timeoutMs`. Call it while the stream is
   * still listed in `runner.active()`: a stream that already ended never emits again.
   */
  waitForEnd(streamId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(streamId) ?? new Set<() => void>();
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0 && this.waiters.get(streamId) === waiters) this.waiters.delete(streamId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
      this.waiters.set(streamId, waiters);
    });
  }
}

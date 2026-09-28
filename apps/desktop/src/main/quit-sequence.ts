// The shutdown run once quitting is decided (J2-B L7). Every step is bounded: a hung MCP server, worker,
// agent process or run never keeps NOVA alive (the user asked to quit; the OS session may wait on it).
// No Electron import: tested in Node.
import type { RuntimeLogger } from "@nova/agent-runtime";
import { describeError } from "./logger";

export interface QuitSequence {
  /** Synchronous stops, first: nothing new starts after them. A throwing one does not skip the others. */
  halt: readonly (() => void)[];
  /** The stops that end asynchronously (servers, process groups, workers, runs), in their own order. */
  stop(): Promise<unknown>;
  /** Last, whether `stop` ended, failed or timed out (closes the store). */
  finish(): void;
  timeoutMs: number;
  logger?: RuntimeLogger;
}

/** Resolves once `finish` ran, `timeoutMs` after `stop` began at the latest. */
export async function runQuitSequence(sequence: QuitSequence): Promise<"stopped" | "timed_out"> {
  for (const halt of sequence.halt) {
    try {
      halt();
    } catch (error) {
      sequence.logger?.warn("quit step failed", { error: describeError(error) });
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), sequence.timeoutMs);
  });
  const stopped = Promise.resolve()
    .then(() => sequence.stop())
    .then(
      () => "stopped" as const,
      (error: unknown) => {
        sequence.logger?.warn("quit stop failed", { error: describeError(error) });
        return "stopped" as const;
      },
    );
  const outcome = await Promise.race([stopped, timedOut]);
  clearTimeout(timer);
  if (outcome === "timed_out") sequence.logger?.warn("quit stop timed out", { timeoutMs: sequence.timeoutMs });
  try {
    sequence.finish();
  } catch (error) {
    sequence.logger?.error("quit finish failed", { error: describeError(error) });
  }
  return outcome;
}

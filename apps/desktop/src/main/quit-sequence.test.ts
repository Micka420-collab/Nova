// Quitting always completes: a stop that never ends, rejects or a halt that throws can delay the quit
// by the timeout at most, and the store is closed in every case.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runQuitSequence } from "./quit-sequence";

afterEach(() => {
  vi.useRealTimers();
});

function logger() {
  const lines: string[] = [];
  return { lines, logger: { info: (msg: string) => lines.push(`info ${msg}`), warn: (msg: string) => lines.push(`warn ${msg}`), error: (msg: string) => lines.push(`error ${msg}`) } };
}

describe("quit sequence", () => {
  it("halts, stops, then finishes, in that order", async () => {
    const calls: string[] = [];
    const outcome = await runQuitSequence({
      halt: [() => calls.push("halt schedules"), () => calls.push("halt runs")],
      stop: async () => {
        calls.push("stop");
      },
      finish: () => calls.push("finish"),
      timeoutMs: 5_000,
    });
    expect(outcome).toBe("stopped");
    expect(calls).toEqual(["halt schedules", "halt runs", "stop", "finish"]);
  });

  it("completes at the timeout when a stop never ends, and still closes the store", async () => {
    vi.useFakeTimers();
    const { lines, logger: log } = logger();
    const finish = vi.fn<() => void>();
    let settled = false;
    const quit = runQuitSequence({ halt: [], stop: () => new Promise(() => {}), finish, timeoutMs: 5_000, logger: log }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await quit).toBe("timed_out");
    expect(finish).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["warn quit stop timed out"]);
  });

  it("goes on past a throwing halt, a rejected stop and a throwing finish", async () => {
    const { lines, logger: log } = logger();
    const later = vi.fn<() => void>();
    const outcome = await runQuitSequence({
      halt: [
        () => {
          throw new Error("tray already gone");
        },
        later,
      ],
      stop: () => Promise.reject(new Error("worker crashed")),
      finish: () => {
        throw new Error("store busy");
      },
      timeoutMs: 5_000,
      logger: log,
    });
    expect(outcome).toBe("stopped");
    expect(later).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(["warn quit step failed", "warn quit stop failed", "error quit finish failed"]);
  });
});

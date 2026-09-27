import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger";
import { ServiceError } from "./service-error";
import { ManagedWorker, scrubEnv } from "./workers";
import type { MainToWorker } from "../workers/protocol";

const logger: Logger = { file: "/dev/null", info: () => {}, warn: () => {}, error: () => {} };

/** In-memory utilityProcess: records what main posts, lets the test answer or crash it. */
class FakeChild extends EventEmitter {
  static next = 100;
  readonly pid = FakeChild.next++;
  readonly posted: MainToWorker[] = [];
  readonly stdout = null;
  readonly stderr = null;
  killed = false;
  postMessage(message: MainToWorker): void {
    this.posted.push(message);
  }
  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
  ready(): void {
    this.emit("message", { kind: "ready", worker: "fs-worker", pid: this.pid });
  }
  reply(result: unknown): void {
    const request = this.posted.at(-1);
    if (request?.kind !== "request") throw new Error("no request");
    this.emit("message", { kind: "response", id: request.id, ok: true, result });
  }
  crash(): void {
    this.emit("exit", 139);
  }
}

function setup(options: { maxRestarts?: number } = {}) {
  const children: FakeChild[] = [];
  const forkEnvs: Record<string, string | undefined>[] = [];
  const worker = new ManagedWorker(
    { name: "fs-worker", entry: "/app/out/main/workers/fs-worker.js", restartDelayMs: 1, ...options },
    {
      logger,
      env: { PATH: "/usr/bin", HOME: "/home/u", OPENROUTER_API_KEY: "sk-or-v1-x", NODE_OPTIONS: "--inspect" },
      fork: (_entry, _args, forkOptions) => {
        const child = new FakeChild();
        children.push(child);
        forkEnvs.push(forkOptions.env as Record<string, string | undefined>);
        return child as unknown as UtilityProcess;
      },
    },
  );
  return { worker, children, forkEnvs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scrubEnv", () => {
  it("keeps only allowlisted, non-credential variables", () => {
    expect(
      scrubEnv(
        {
          PATH: "/bin",
          HOME: "/h",
          LC_ALL: "fr_FR.UTF-8",
          XDG_RUNTIME_DIR: "/run/user/1",
          OPENROUTER_API_KEY: "sk",
          GITHUB_TOKEN: "t",
          NOVA_USER_DATA_DIR: "/d",
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: "--require x",
          AWS_SECRET_ACCESS_KEY: "s",
          XDG_SESSION_COOKIE: "c",
        },
        { NOVA_RG_PATH: "/rg" },
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "fr_FR.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1",
      NOVA_RG_PATH: "/rg",
    });
    expect(() => scrubEnv({}, { API_TOKEN: "x" })).toThrow(/Refusing/);
  });
});

describe("ManagedWorker", () => {
  it("queues requests until ready, then answers them; the worker never gets secrets", async () => {
    const { worker, children, forkEnvs } = setup();
    worker.start();
    const pong = worker.request("ping");
    expect(children[0]?.posted).toEqual([]);
    children[0]?.ready();
    expect(worker.state).toBe("running");
    children[0]?.reply({ ok: 1 });
    await expect(pong).resolves.toEqual({ ok: 1 });
    expect(forkEnvs[0]).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("rejects in-flight requests as unavailable on a crash and restarts the worker", async () => {
    const { worker, children } = setup();
    worker.start();
    children[0]?.ready();
    const pending = worker.request("slow");
    children[0]?.crash();
    await expect(pending).rejects.toBeInstanceOf(ServiceError);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(worker.state).toBe("restarting");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]?.ready();
    expect(worker.state).toBe("running");
  });

  it("gives up after too many crashes in the window, until started again", async () => {
    const { worker, children } = setup({ maxRestarts: 2 });
    worker.start();
    children[0]?.crash();
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]?.crash();
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2]?.crash();
    expect(worker.state).toBe("failed");
    await expect(worker.request("ping")).rejects.toMatchObject({ code: "unavailable" });
    worker.start();
    expect(children).toHaveLength(4);
  });

  it("stop() kills the worker without restarting it", async () => {
    const { worker, children } = setup();
    worker.start();
    children[0]?.ready();
    const pending = worker.request("slow");
    worker.stop();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(children[0]?.killed).toBe(true);
    expect(worker.state).toBe("stopped");
    expect(children).toHaveLength(1);
  });
});

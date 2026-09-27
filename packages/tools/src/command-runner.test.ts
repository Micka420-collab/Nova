import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProcessCommandRunner, scrubCommandEnv } from "./command-runner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nova-cmd-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const runner = createProcessCommandRunner({
  resolveCwd: async (_ws, cwd) => (cwd === "" ? root : cwd === "outside" ? null : join(root, cwd)),
  env: { PATH: process.env["PATH"], OPENROUTER_API_KEY: "sk-or-v1-secret", NODE_OPTIONS: "--inspect" },
  maxOutputBytes: 1_000,
  killGraceMs: 200,
  backgroundSettleMs: 300,
});

const node = process.execPath;
const spec = (argv: string[], extra: Partial<{ cwd: string; timeoutMs: number }> = {}) => ({
  workspaceId: "w",
  missionId: "m",
  argv,
  cwd: extra.cwd ?? "",
  timeoutMs: extra.timeoutMs ?? 10_000,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("process command runner", () => {
  it("runs argv without a shell, in the confined cwd, with a scrubbed env", async () => {
    const script = "console.log(process.cwd(), process.env.OPENROUTER_API_KEY ?? 'nokey', process.env.NODE_OPTIONS ?? 'noopts', '$HOME && echo')";
    const outcome = await runner.run(spec([node, "-e", script]), new AbortController().signal);
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, isolationLevel: "L0" });
    expect(outcome.output.trim()).toBe(`${root} nokey noopts $HOME && echo`);
  });

  it("refuses a cwd outside the workspace and a missing program", async () => {
    await expect(runner.run(spec([node, "-e", ""], { cwd: "outside" }), new AbortController().signal)).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(runner.run(spec(["nova-no-such-program-xyz"]), new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps only the tail of a huge output", async () => {
    const outcome = await runner.run(spec([node, "-e", "process.stdout.write('x'.repeat(200000) + 'END')"]), new AbortController().signal);
    expect(outcome.output.length).toBeLessThanOrEqual(1_000);
    expect(outcome.output.endsWith("END")).toBe(true);
    expect(outcome).toMatchObject({ truncated: true, outputBytes: 200_003 });
  });

  it.skipIf(process.platform === "win32")("kills the whole process tree on timeout and on abort", async () => {
    // The parent spawns a grandchild that prints its pid and ignores SIGTERM.
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('grandchild', process.pid); setInterval(()=>{}, 1000)"], { stdio: "inherit" });
      setInterval(() => {}, 1000);`;
    const timed = await runner.run(spec([node, "-e", script], { timeoutMs: 1_000 }), new AbortController().signal);
    expect(timed.timedOut).toBe(true);
    const pid = Number(/grandchild (\d+)/.exec(timed.output)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(false);

    const controller = new AbortController();
    const pending = runner.run(spec([node, "-e", script]), controller.signal);
    setTimeout(() => controller.abort(), 500);
    const aborted = await pending;
    expect(aborted.cancelled).toBe(true);
  });

  it("starts, lists and stops background processes per mission", async () => {
    const started = await runner.startBackground(spec([node, "-e", "console.log('ready'); setInterval(()=>{},1000)"]));
    expect(started.initialOutput).toContain("ready");
    expect(runner.list("m").map((process) => process.id)).toEqual([started.process.id]);
    await runner.stopAll("m");
    expect(runner.list("m")).toEqual([]);
  });

  it("refuses secret-looking extra variables", () => {
    expect(() => scrubCommandEnv({}, { GITHUB_TOKEN: "x" })).toThrow(/not allowed/);
    expect(scrubCommandEnv({ PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", LC_ALL: "C" })).toEqual({ PATH: "/bin", LC_ALL: "C" });
  });
});

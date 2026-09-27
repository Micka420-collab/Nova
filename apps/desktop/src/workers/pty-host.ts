// pty-host utilityProcess: will own node-pty terminal sessions (E13). Phase 0: ping + self-test.
// node-pty is a native N-API addon kept EXTERNAL to the bundle and unpacked from the asar
// (ADR-012), so it is loaded lazily: a load failure answers `unavailable` instead of crashing.
import { serveWorker, WorkerMethodError } from "./serve";

type NodePty = typeof import("node-pty");

async function loadNodePty(): Promise<NodePty> {
  try {
    return await import("node-pty");
  } catch {
    throw new WorkerMethodError("unavailable", "node-pty could not be loaded");
  }
}

/** Spawns `echo nova-pty-ok` in a real pty and returns what it printed. Diagnostics only. */
async function selfTest(): Promise<{ output: string; exitCode: number }> {
  const pty = await loadNodePty();
  const windows = process.platform === "win32";
  const shell = windows ? "cmd.exe" : "/bin/sh";
  const args = windows ? ["/d", "/c", "echo nova-pty-ok"] : ["-c", "echo nova-pty-ok"];
  const child = pty.spawn(shell, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  return new Promise((resolve) => {
    let output = "";
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => resolve({ output: output.trim(), exitCode }));
  });
}

serveWorker("pty-host", { selftest: () => selfTest() });

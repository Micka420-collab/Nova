// Native/binary dependencies kept EXTERNAL to the bundles (ADR-012): node-pty (loaded by the
// pty-host worker) and the ripgrep binary. In a packaged app they live in app.asar.unpacked
// (electron-builder `asarUnpack`); a binary must be spawned from there, not from inside the asar.
import { join } from "node:path";
import type { WorkerName } from "../workers/protocol";
import type { WorkerSpec } from "./workers";

/** Maps a path inside `app.asar` to its unpacked twin (no-op outside an asar). */
export function unpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

/** Absolute path of the ripgrep executable shipped with @vscode/ripgrep. */
export async function resolveRipgrepPath(): Promise<string> {
  const { rgPath } = await import("@vscode/ripgrep");
  return unpackedPath(rgPath);
}

/** Built worker entries sit next to the main bundle: out/main/workers/<name>.js. */
export function workerSpecs(mainDir: string, extraEnv: { ripgrepPath: string | null }): Record<WorkerName, WorkerSpec> {
  const entry = (name: WorkerName): string => join(mainDir, "workers", `${name}.js`);
  return {
    "pty-host": { name: "pty-host", entry: entry("pty-host") },
    "fs-worker": {
      name: "fs-worker",
      entry: entry("fs-worker"),
      ...(extraEnv.ripgrepPath ? { env: { NOVA_RG_PATH: extraEnv.ripgrepPath } } : {}),
    },
    "agent-runtime": { name: "agent-runtime", entry: entry("agent-runtime") },
    // A tool call may legitimately run for minutes; McpService enforces its own per-call cap below this.
    "mcp-host": { name: "mcp-host", entry: entry("mcp-host"), requestTimeoutMs: 10 * 60_000 },
  };
}

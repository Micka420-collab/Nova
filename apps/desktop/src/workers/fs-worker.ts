// fs-worker utilityProcess: file watcher (chokidar), ripgrep searches, quick-open index and
// confined reads/writes for the renderer (E1/E2/E4/E10). Main registers each open workspace with
// its canonical root; see ./fs/protocol for the methods. The ripgrep path comes from main in
// NOVA_RG_PATH (already mapped to app.asar.unpacked when packaged).
import { execFile } from "node:child_process";
import { createFsHandlers } from "./fs/handlers";
import type { WorkerNotify } from "./protocol";
import { serveWorker, WorkerMethodError, type WorkerHandler } from "./serve";

const rgPath = process.env["NOVA_RG_PATH"] ?? null;

function ripgrepVersion(): Promise<{ path: string; version: string }> {
  if (!rgPath) return Promise.reject(new WorkerMethodError("unavailable", "ripgrep path not provided"));
  return new Promise((resolve, reject) => {
    execFile(rgPath, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      if (error) reject(new WorkerMethodError("unavailable", "ripgrep did not run"));
      else resolve({ path: rgPath, version: stdout.split("\n")[0] ?? "" });
    });
  });
}

const handlers = createFsHandlers({
  rgPath,
  // Watch batches fire outside any request: posted straight to main as `notify` messages.
  notify: (method, params) => process.parentPort.postMessage({ kind: "notify", method, params } satisfies WorkerNotify),
});

const methods: Record<string, WorkerHandler> = { selftest: () => ripgrepVersion() };
for (const [name, handler] of Object.entries(handlers)) {
  if (name !== "dispose") methods[name] = handler as WorkerHandler;
}

serveWorker("fs-worker", methods);
process.once("exit", () => void handlers.dispose());

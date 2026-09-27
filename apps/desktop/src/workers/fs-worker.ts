// fs-worker utilityProcess: will own the file watcher (chokidar), ripgrep searches and confined
// reads/writes (E1/E4, A2). Phase 0: ping + a ripgrep self-test (main passes the binary path in
// NOVA_RG_PATH, already mapped to app.asar.unpacked when packaged).
import { execFile } from "node:child_process";
import { serveWorker, WorkerMethodError } from "./serve";

function ripgrepVersion(): Promise<{ path: string; version: string }> {
  const path = process.env["NOVA_RG_PATH"];
  if (!path) return Promise.reject(new WorkerMethodError("unavailable", "ripgrep path not provided"));
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 10_000 }, (error, stdout) => {
      if (error) reject(new WorkerMethodError("unavailable", "ripgrep did not run"));
      else resolve({ path, version: stdout.split("\n")[0] ?? "" });
    });
  });
}

serveWorker("fs-worker", { selftest: () => ripgrepVersion() });

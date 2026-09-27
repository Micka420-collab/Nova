// `--nova-selftest=workers`: starts every utilityProcess worker, pings it, runs the native self-tests
// (node-pty spawns `echo nova-pty-ok`; ripgrep prints its version), prints one JSON line on stdout
// and exits (0 = all passed). Opens no window and no database; reads nothing of the user's.
// Used by E2E and by the packaged-build check to prove the native dependencies load (ADR-012).
import type { WorkerName } from "../workers/protocol";
import { WORKER_NAMES } from "../workers/protocol";
import type { WorkerPool } from "./workers";

export const SELFTEST_FLAG = "--nova-selftest=workers";

export interface SelfTestReport {
  ok: boolean;
  workers: Record<WorkerName, { ok: boolean; pid: number | null; error: string | null }>;
  pty: { ok: boolean; output: string | null; error: string | null };
  ripgrep: { ok: boolean; version: string | null; error: string | null };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runWorkerSelfTest(pool: WorkerPool): Promise<SelfTestReport> {
  const entries = await Promise.all(
    WORKER_NAMES.map(async (name) => {
      try {
        const pong = await pool.get(name).ping();
        return [name, { ok: pong.worker === name, pid: pong.pid, error: null }] as const;
      } catch (error) {
        return [name, { ok: false, pid: null, error: message(error) }] as const;
      }
    }),
  );
  const workers = Object.fromEntries(entries) as SelfTestReport["workers"];

  const pty = await pool
    .get("pty-host")
    .request<{ output: string; exitCode: number }>("selftest")
    .then(
      (result) => ({ ok: result.output.includes("nova-pty-ok") && result.exitCode === 0, output: result.output, error: null }),
      (error: unknown) => ({ ok: false, output: null, error: message(error) }),
    );
  const ripgrep = await pool
    .get("fs-worker")
    .request<{ version: string }>("selftest")
    .then(
      (result) => ({ ok: result.version.startsWith("ripgrep "), version: result.version, error: null }),
      (error: unknown) => ({ ok: false, version: null, error: message(error) }),
    );
  const ok = Object.values(workers).every((worker) => worker.ok) && pty.ok && ripgrep.ok;
  return { ok, workers, pty, ripgrep };
}

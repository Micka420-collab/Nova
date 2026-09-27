// Honest isolation reporting (S3). J2-A enforces L0 only (separate process, scrubbed env, confined
// cwd, timeouts and caps). Candidates for L1 are DETECTED and reported, never claimed: the level
// stays L0 until the L1 runner exists and is tested.
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { IsolationLevel } from "@nova/shared";

export interface IsolationCandidate {
  level: Exclude<IsolationLevel, "L0">;
  tool: "bubblewrap" | "sandbox-exec";
  /** Absolute path of the executable found on PATH; null when absent. */
  path: string | null;
}

export interface IsolationReport {
  /** Level NOVA really enforces today. */
  level: IsolationLevel;
  /** French line for the contract and the command cards (UX 7.1). */
  description: string;
  /** Stronger levels this machine could support later (report only). */
  candidates: IsolationCandidate[];
}

export const ISOLATION_DESCRIPTIONS: Readonly<Record<IsolationLevel, string>> = {
  L0: "Isolation : processus séparé, sans isolation du système de fichiers.",
  L1: "Isolation : bac à sable du système (fichiers hors projet en lecture seule).",
  L2: "Isolation : conteneur dédié.",
};

async function findOnPath(name: string, pathEnv: string | undefined): Promise<string | null> {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    const found = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (found) return candidate;
  }
  return null;
}

export interface DetectIsolationOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string | undefined;
}

export async function detectIsolation(options: DetectIsolationOptions = {}): Promise<IsolationReport> {
  const platform = options.platform ?? process.platform;
  const pathEnv = "pathEnv" in options ? options.pathEnv : process.env["PATH"];
  const candidates: IsolationCandidate[] = [];
  if (platform === "linux") {
    candidates.push({ level: "L1", tool: "bubblewrap", path: await findOnPath("bwrap", pathEnv) });
  } else if (platform === "darwin") {
    candidates.push({ level: "L1", tool: "sandbox-exec", path: await findOnPath("sandbox-exec", pathEnv) });
  }
  return { level: "L0", description: ISOLATION_DESCRIPTIONS.L0, candidates };
}

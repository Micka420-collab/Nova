// Kills a session's whole process tree (POSIX). Interactive shells put each job in its own process
// group, so signalling the shell's group is not enough: `npm run dev &` would survive. The tree is
// read from `ps` (Linux and macOS), every descendant gets SIGTERM and the shell SIGHUP (what closing
// a terminal window sends); whatever is still alive after the grace period gets SIGKILL.
// Windows: node-pty's kill() closes the pseudo console, which ends every process attached to it.
import { execFile } from "node:child_process";

export interface ProcessEntry {
  pid: number;
  ppid: number;
}

export interface KillTreeDeps {
  listProcesses(): Promise<ProcessEntry[]>;
  /** Returns false when the process does not exist (ESRCH). */
  signal(pid: number, signal: NodeJS.Signals | 0): boolean;
  graceMs: number;
}

export function listProcessesWithPs(): Promise<ProcessEntry[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const entries: ProcessEntry[] = [];
      for (const line of stdout.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid)) entries.push({ pid: pid as number, ppid: ppid as number });
      }
      resolve(entries);
    });
  });
}

export function signalProcess(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function descendantsOf(root: number, entries: readonly ProcessEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of entries) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const result: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return result;
}

export const defaultKillTreeDeps: KillTreeDeps = {
  listProcesses: listProcessesWithPs,
  signal: signalProcess,
  graceMs: 1_500,
};

/** Resolves once every process of the tree was signalled (SIGKILL included, after the grace). */
export async function killTree(rootPid: number, deps: KillTreeDeps = defaultKillTreeDeps): Promise<void> {
  const tree = descendantsOf(rootPid, await deps.listProcesses());
  for (const pid of tree) deps.signal(pid, "SIGTERM");
  deps.signal(rootPid, "SIGHUP");
  await new Promise((resolve) => setTimeout(resolve, deps.graceMs));
  // Children forked during the grace period are caught by a second read.
  const late = descendantsOf(rootPid, await deps.listProcesses());
  for (const pid of new Set([...tree, ...late, rootPid])) {
    if (deps.signal(pid, 0)) deps.signal(pid, "SIGKILL");
  }
}

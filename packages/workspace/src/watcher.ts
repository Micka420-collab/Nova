// Workspace watcher (E1): chokidar 5 (no native module), ignored folders skipped, changes coalesced
// per path and emitted in debounced batches; a batch above `maxBatch` becomes a single `overflow`
// (the renderer re-lists what it shows instead of replaying thousands of events).
import { watch, type FSWatcher } from "chokidar";
import type { FileChange } from "@nova/shared";
import { toRelativePath } from "./confine";
import type { IgnoreMatcher } from "./ignore-rules";

export type WatchBatch = { type: "changes"; changes: FileChange[] } | { type: "overflow" };

export interface WatchOptions {
  debounceMs?: number;
  maxBatch?: number;
}

export interface WorkspaceWatcher {
  /** Resolves once the initial scan is done (events before that are not reported). */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

const RULE_FILES = new Set([".gitignore", ".novaignore"]);

/** Loads the root ignore rules first, so ignored folders are never watched. */
export async function watchWorkspace(
  root: string,
  matcher: IgnoreMatcher,
  emit: (batch: WatchBatch) => void,
  options: WatchOptions = {},
): Promise<WorkspaceWatcher> {
  await matcher.load("");
  const debounceMs = options.debounceMs ?? 100;
  const maxBatch = options.maxBatch ?? 500;
  let pending = new Map<string, FileChange>();
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const flush = (): void => {
    timer = null;
    if (closed) return;
    if (overflow) emit({ type: "overflow" });
    else if (pending.size > 0) emit({ type: "changes", changes: [...pending.values()] });
    pending = new Map();
    overflow = false;
  };

  const record = (kind: FileChange["kind"], absolute: string, isDirectory: boolean): void => {
    const path = toRelativePath(root, absolute);
    if (path === null || path === "") return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (RULE_FILES.has(name)) {
      matcher.invalidate();
      void matcher.load("").catch(() => {});
    }
    if (!overflow) {
      const previous = pending.get(path);
      // created then changed stays "created"; anything then deleted is "deleted".
      const merged = previous?.kind === "created" && kind === "changed" ? "created" : kind;
      pending.set(path, { kind: merged, path, isDirectory });
      if (pending.size > maxBatch) {
        overflow = true;
        pending = new Map();
      }
    }
    timer ??= setTimeout(flush, debounceMs);
  };

  const watcher: FSWatcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (absolute, stats) => {
      const path = toRelativePath(root, absolute);
      if (path === null) return true;
      if (path === "") return false;
      return matcher.isIgnored(path, stats?.isDirectory() ?? false);
    },
  });
  watcher
    .on("add", (path) => record("created", path, false))
    .on("addDir", (path) => record("created", path, true))
    .on("change", (path) => record("changed", path, false))
    .on("unlink", (path) => record("deleted", path, false))
    .on("unlinkDir", (path) => record("deleted", path, true))
    .on("error", () => {
      // Unwatchable subtrees (permissions, too many watchers) must not kill the worker; the tree
      // still lists lazily, only live updates are missing for that part.
    });

  const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));

  return {
    ready,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await watcher.close();
    },
  };
}

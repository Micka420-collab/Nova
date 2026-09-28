// Test-only helpers (not exported from the package index): realpath'd temp workspaces, the ripgrep
// binary shipped with the desktop app, and an in-memory CheckpointIndex.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Checkpoint, CheckpointFile, ContentHash } from "@nova/shared";
import type { CheckpointIndex } from "./checkpoints";

export interface TempDir {
  path: string;
  write(relative: string, content: string | Uint8Array): Promise<string>;
  cleanup(): Promise<void>;
}

/** A temp folder, realpath'd (macOS /var → /private/var) as production roots are. */
export async function makeTempDir(prefix = "nova-ws-"): Promise<TempDir> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    path,
    async write(relative, content) {
      const target = join(path, ...relative.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return target;
    },
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

/** Absolute path of the ripgrep binary installed for @nova/desktop. */
export async function ripgrepForTests(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(join(here, "../../../apps/desktop/package.json"));
  const module = (await import(require.resolve("@vscode/ripgrep"))) as { rgPath: string };
  return module.rgPath;
}

export function createMemoryCheckpointIndex(now: () => number = Date.now): CheckpointIndex {
  const checkpoints = new Map<string, Omit<Checkpoint, "files">>();
  const files = new Map<string, CheckpointFile[]>();
  const withFiles = (id: string): Checkpoint | null => {
    const checkpoint = checkpoints.get(id);
    if (!checkpoint) return null;
    const list = [...(files.get(id) ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
    return { ...checkpoint, files: list };
  };
  return {
    createCheckpoint(input) {
      const checkpoint = { id: randomUUID(), createdAt: now(), ...input };
      checkpoints.set(checkpoint.id, checkpoint);
      return { ...checkpoint, files: [] };
    },
    upsertFile(file) {
      const list = files.get(file.checkpointId) ?? [];
      const existing = list.find((entry) => entry.path === file.path);
      if (existing) {
        existing.afterHash = file.afterHash;
        existing.userHashSeen ??= file.userHashSeen;
      } else list.push({ ...file });
      files.set(file.checkpointId, list);
    },
    get: withFiles,
    list({ workspaceId, missionId, limit }) {
      return [...checkpoints.values()]
        .filter((c) => c.workspaceId === workspaceId && (missionId === null || c.missionId === missionId))
        .reverse()
        .slice(0, limit)
        .map((c) => withFiles(c.id) as Checkpoint);
    },
    listAges: () => [...checkpoints.values()].map((c) => ({ id: c.id, createdAt: c.createdAt })),
    deleteCheckpoints(ids) {
      for (const id of ids) {
        checkpoints.delete(id);
        files.delete(id);
      }
    },
    referencedHashes() {
      const hashes = new Set<ContentHash>();
      for (const list of files.values()) {
        for (const file of list) {
          for (const hash of [file.beforeHash, file.afterHash, file.userHashSeen]) if (hash) hashes.add(hash);
        }
      }
      return hashes;
    },
  };
}

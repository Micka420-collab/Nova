// Content-addressed object store for checkpoints (A10): dataDir/checkpoints/objects/<sha256>,
// gzip-compressed, written atomically, deduplicated by hash, verified on read.
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ContentHash } from "@nova/shared";
import { errnoCode, WorkspaceError } from "./errors";
import { atomicWrite } from "./files";
import { sha256 } from "./hash";

const HASH = /^[0-9a-f]{64}$/;

export interface StoredObject {
  hash: ContentHash;
  /** Compressed size on disk. */
  size: number;
  mtimeMs: number;
}

export interface ObjectStore {
  readonly dir: string;
  put(bytes: Uint8Array): Promise<ContentHash>;
  /** Original bytes; throws `not_found` when missing, `failed` when corrupt. */
  get(hash: ContentHash): Promise<Buffer>;
  has(hash: ContentHash): Promise<boolean>;
  list(): Promise<StoredObject[]>;
  remove(hash: ContentHash): Promise<void>;
}

export function createObjectStore(dir: string): ObjectStore {
  const pathOf = (hash: ContentHash): string => {
    if (!HASH.test(hash)) throw new WorkspaceError("invalid_argument", "invalid object hash");
    return join(dir, hash);
  };
  const ready = mkdir(dir, { recursive: true });

  const store: ObjectStore = {
    dir,
    async put(bytes) {
      await ready;
      const hash = sha256(bytes);
      if (!(await store.has(hash))) await atomicWrite(pathOf(hash), gzipSync(bytes));
      return hash;
    },
    async get(hash) {
      let compressed: Buffer;
      try {
        compressed = await readFile(pathOf(hash));
      } catch (error) {
        if (errnoCode(error) === "ENOENT") throw new WorkspaceError("not_found", "checkpoint object missing");
        throw error;
      }
      let bytes: Buffer;
      try {
        bytes = gunzipSync(compressed);
      } catch {
        throw new WorkspaceError("failed", "checkpoint object corrupt");
      }
      if (sha256(bytes) !== hash) throw new WorkspaceError("failed", "checkpoint object corrupt");
      return bytes;
    },
    async has(hash) {
      try {
        await stat(pathOf(hash));
        return true;
      } catch {
        return false;
      }
    },
    async list() {
      await ready;
      const names = (await readdir(dir)).filter((name) => HASH.test(name));
      const objects: StoredObject[] = [];
      for (const name of names) {
        try {
          const info = await stat(join(dir, name));
          objects.push({ hash: name, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // removed concurrently
        }
      }
      return objects;
    },
    async remove(hash) {
      await rm(pathOf(hash), { force: true });
    },
  };
  return store;
}

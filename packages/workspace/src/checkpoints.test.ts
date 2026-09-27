import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointStore, type CheckpointStore } from "./checkpoints";
import { sha256 } from "./hash";
import { createObjectStore } from "./object-store";
import { createMemoryCheckpointIndex, makeTempDir, type TempDir } from "./test-support";

let workspace: TempDir;
let data: TempDir;
let store: CheckpointStore;
let clock: number;

beforeEach(async () => {
  clock = 1_000;
  workspace = await makeTempDir();
  data = await makeTempDir("nova-data-");
  store = createCheckpointStore({
    index: createMemoryCheckpointIndex(() => clock),
    objects: createObjectStore(join(data.path, "checkpoints", "objects")),
    now: () => clock,
    gcGraceMs: 0,
  });
});
afterEach(async () => {
  await workspace.cleanup();
  await data.cleanup();
});

const read = (path: string): Promise<string> => readFile(join(workspace.path, path), "utf8");

/** Simulates a tool write of `content` over `path`, checkpointed. */
async function toolWrite(checkpointId: string, path: string, content: string | null): Promise<void> {
  const pending = await store.snapshotBeforeWrite({ checkpointId, root: workspace.path, path });
  if (content === null) await import("node:fs/promises").then((fs) => fs.rm(join(workspace.path, path)));
  else await workspace.write(path, content);
  await pending.commit(content);
}

function newCheckpoint(label = "Étape 1") {
  return store.create({ workspaceId: "ws", missionId: null, label, reason: "tool_write" });
}

describe("checkpoints", () => {
  it("stores objects content-addressed and compressed, then restores one file among three", async () => {
    await workspace.write("a.ts", "a1\n");
    await workspace.write("b.ts", "b1\n");
    const checkpoint = newCheckpoint();
    await toolWrite(checkpoint.id, "a.ts", "a2\n");
    await toolWrite(checkpoint.id, "b.ts", "b2\n");
    await toolWrite(checkpoint.id, "c.ts", "c2\n");

    const objects = await readdir(join(data.path, "checkpoints", "objects"));
    expect(objects).toContain(sha256("a1\n"));
    const raw = await readFile(join(data.path, "checkpoints", "objects", sha256("a1\n")));
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip magic

    const result = await store.restoreFile({ checkpointId: checkpoint.id, root: workspace.path, path: "b.ts" });
    expect(result).toEqual({ status: "restored", path: "b.ts", checkpointId: checkpoint.id });
    expect([await read("a.ts"), await read("b.ts"), await read("c.ts")]).toEqual(["a2\n", "b1\n", "c2\n"]);
    // Idempotent: restoring again is a no-op success.
    expect((await store.restoreFile({ checkpointId: checkpoint.id, root: workspace.path, path: "b.ts" })).status).toBe("restored");
  });

  it("never overwrites a file the user changed since: conflict, then a jsdiff merge proposal", async () => {
    await workspace.write("app.ts", "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n");
    const checkpoint = newCheckpoint();
    await toolWrite(checkpoint.id, "app.ts", "line1\nAGENT\nline3\nline4\nline5\nline6\nline7\nline8\n");
    const userVersion = "line1\nAGENT\nline3\nline4\nline5\nline6\nline7\nUSER\n";
    await writeFile(join(workspace.path, "app.ts"), userVersion);

    const result = await store.restoreFile({ checkpointId: checkpoint.id, root: workspace.path, path: "app.ts" });
    expect(result).toMatchObject({ status: "conflict", path: "app.ts", currentHash: sha256(userVersion) });
    expect(await read("app.ts")).toBe(userVersion);

    const proposal = await store.proposeMerge({ checkpointId: checkpoint.id, root: workspace.path, path: "app.ts" });
    expect(proposal).toEqual({
      status: "clean",
      path: "app.ts",
      currentHash: sha256(userVersion),
      merged: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nUSER\n",
    });
    if (proposal.status !== "clean") return;
    const applied = await store.applyMerge({
      checkpointId: checkpoint.id,
      root: workspace.path,
      path: "app.ts",
      merged: proposal.merged,
      expectedHash: proposal.currentHash,
    });
    expect(applied.status).toBe("restored");
    expect(await read("app.ts")).toBe(proposal.merged);
  });

  it("reports an overlapping user edit as conflicting, with the three versions", async () => {
    await workspace.write("x.ts", "one\n");
    const checkpoint = newCheckpoint();
    await toolWrite(checkpoint.id, "x.ts", "two\n");
    await writeFile(join(workspace.path, "x.ts"), "three\n");
    expect(await store.proposeMerge({ checkpointId: checkpoint.id, root: workspace.path, path: "x.ts" })).toMatchObject({
      status: "conflicting",
      base: "two\n",
      current: "three\n",
      target: "one\n",
    });
  });

  it("restores everything (created files removed, deleted ones recreated) behind a safety checkpoint", async () => {
    await workspace.write("keep.ts", "k1\n");
    await workspace.write("gone/old.ts", "old\n");
    const checkpoint = newCheckpoint();
    await toolWrite(checkpoint.id, "keep.ts", "k2\n");
    await toolWrite(checkpoint.id, "new.ts", "n\n");
    await toolWrite(checkpoint.id, "gone/old.ts", null);
    await import("node:fs/promises").then((fs) => fs.rm(join(workspace.path, "gone"), { recursive: true }));

    const result = await store.restoreAll({ checkpointId: checkpoint.id, root: workspace.path });
    expect(result.results.map((entry) => entry.status)).toEqual(["restored", "restored", "restored"]);
    expect(await read("keep.ts")).toBe("k1\n");
    expect(await read("gone/old.ts")).toBe("old\n");
    await expect(read("new.ts")).rejects.toThrow(/ENOENT/);

    // The restore itself is undoable.
    expect(result.safetyCheckpointId).not.toBeNull();
    const undo = await store.restoreAll({ checkpointId: result.safetyCheckpointId as string, root: workspace.path });
    expect(undo.results.every((entry) => entry.status === "restored")).toBe(true);
    expect([await read("keep.ts"), await read("new.ts")]).toEqual(["k2\n", "n\n"]);
  });

  it("purges expired checkpoints and their unreferenced objects, keeping shared ones", async () => {
    await workspace.write("a.ts", "shared\n");
    const old = newCheckpoint("vieux");
    await toolWrite(old.id, "a.ts", "old-after\n");
    clock = 50_000;
    const recent = newCheckpoint("récent");
    await toolWrite(recent.id, "a.ts", "shared\n");

    const objectsDir = join(data.path, "checkpoints", "objects");
    for (const name of await readdir(objectsDir)) await utimes(join(objectsDir, name), 0, 0);
    const report = await store.purge({ maxAgeMs: 10_000, maxBytes: 10_000_000 });
    expect(report).toMatchObject({ deletedCheckpoints: 1, deletedObjects: 0 });
    // "old-after" is still referenced as the recent checkpoint's before-content.
    expect(store.get(old.id)).toBeNull();
    const sizeReport = await store.purge({ maxAgeMs: 10_000_000, maxBytes: 0 });
    expect(sizeReport.deletedCheckpoints).toBe(1);
    expect(await readdir(objectsDir)).toEqual([]);
  });
});

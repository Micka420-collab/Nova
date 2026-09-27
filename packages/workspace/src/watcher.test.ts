import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIgnoreMatcher } from "./ignore-rules";
import { makeTempDir, type TempDir } from "./test-support";
import { watchWorkspace, type WatchBatch, type WorkspaceWatcher } from "./watcher";

let workspace: TempDir;
let watcher: WorkspaceWatcher | null = null;

beforeEach(async () => {
  workspace = await makeTempDir();
  await workspace.write(".gitignore", "dist/\n");
  await mkdir(join(workspace.path, "dist"));
  await mkdir(join(workspace.path, "src"));
});
afterEach(async () => {
  await watcher?.close();
  watcher = null;
  await workspace.cleanup();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("workspace watcher", () => {
  it("reports created and deleted files in debounced batches, skipping ignored folders", async () => {
    const batches: WatchBatch[] = [];
    watcher = await watchWorkspace(workspace.path, createIgnoreMatcher(workspace.path), (batch) => batches.push(batch), {
      debounceMs: 30,
    });
    await watcher.ready;
    await writeFile(join(workspace.path, "dist", "bundle.js"), "x");
    await writeFile(join(workspace.path, "src", "new.ts"), "x");
    const seen = (): string[] => batches.flatMap((batch) => (batch.type === "changes" ? batch.changes.map((c) => `${c.kind}:${c.path}`) : []));
    await until(() => seen().includes("created:src/new.ts"));
    await rm(join(workspace.path, "src", "new.ts"));
    await until(() => seen().includes("deleted:src/new.ts"));
    expect(seen().some((entry) => entry.includes("dist/"))).toBe(false);
  });

  it("collapses a burst above the batch limit into one overflow", async () => {
    const batches: WatchBatch[] = [];
    watcher = await watchWorkspace(workspace.path, createIgnoreMatcher(workspace.path), (batch) => batches.push(batch), {
      debounceMs: 200,
      maxBatch: 5,
    });
    await watcher.ready;
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(workspace.path, "src", `f${index}.ts`), "x")));
    await until(() => batches.length > 0);
    expect(batches[0]).toEqual({ type: "overflow" });
  });
});

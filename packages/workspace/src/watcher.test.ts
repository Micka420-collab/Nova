import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { atomicWrite } from "./files";
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
  it("watches the tree when chokidar spells the root differently from the workspace root", async () => {
    await workspace.write("src/cart.js", "a\n");
    const batches: WatchBatch[] = [];
    // chokidar normalizes the root it hands back to `ignored` (`C:/w` for `C:\\w` on Windows; here
    // `/w` for `/w/.`): the watcher must not take it for a path outside the workspace.
    watcher = await watchWorkspace(`${workspace.path}${sep}.`, createIgnoreMatcher(workspace.path), (batch) => batches.push(batch), {
      debounceMs: 30,
    });
    await watcher.ready;
    // An editor save (temp file renamed over the target) is reported as a change of the file.
    await atomicWrite(join(workspace.path, "src", "cart.js"), "b\n");
    const seen = (): string[] => batches.flatMap((batch) => (batch.type === "changes" ? batch.changes.map((c) => `${c.kind}:${c.path}`) : []));
    await until(() => seen().includes("changed:src/cart.js")).catch(() => undefined);
    expect(seen()).toContain("changed:src/cart.js");
  });

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

  it("reports changes to gitignored files of watched folders (an open .env tab stays current)", async () => {
    await workspace.write(".gitignore", "dist/\n.env\n*.log\n");
    await workspace.write(".env", "A=1");
    const batches: WatchBatch[] = [];
    watcher = await watchWorkspace(workspace.path, createIgnoreMatcher(workspace.path), (batch) => batches.push(batch), {
      debounceMs: 30,
    });
    await watcher.ready;
    await writeFile(join(workspace.path, ".env"), "A=2");
    await writeFile(join(workspace.path, "src", "debug.log"), "x");
    const seen = (): string[] => batches.flatMap((batch) => (batch.type === "changes" ? batch.changes.map((c) => `${c.kind}:${c.path}`) : []));
    await until(() => seen().includes("changed:.env") && seen().includes("created:src/debug.log"));
    await writeFile(join(workspace.path, "dist", "bundle.js"), "x");
    await rm(join(workspace.path, ".env"));
    await until(() => seen().includes("deleted:.env"));
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

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FilesEvent, SearchMatch } from "@nova/shared";
import { createCheckpointRepo, createEditorStateRepo, createWorkspaceRepo, type NovaStore, openNovaStore } from "@nova/storage";
import { createGitClient, sha256 } from "@nova/workspace";
import type { WorkerNotify } from "../../workers/protocol";
import { createFsHandlers, type FsHandlers } from "../../workers/fs/handlers";
import { createCheckpointsService } from "./checkpoints-service";
import { createFilesService, type FilesService } from "./files-service";
import { createGitService } from "./git-service";
import { createSearchService } from "./search-service";
import { createWorkspaceService, type FsWorkerPort, type WorkspaceService } from "./workspace-service";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function ripgrepPath(): Promise<string> {
  const module = (await import("@vscode/ripgrep")) as { rgPath: string };
  return module.rgPath;
}

/** The fs-worker handlers run in-process behind the same port main uses for the utilityProcess. */
class InProcessWorker implements FsWorkerPort {
  handlers: FsHandlers;
  private readonly listeners = new Set<(event: WorkerNotify) => void>();
  constructor(private readonly rgPath: string) {
    this.handlers = this.spawn();
  }
  spawn(): FsHandlers {
    return createFsHandlers({
      rgPath: this.rgPath,
      notify: (method, params) => {
        for (const listener of this.listeners) listener({ kind: "notify", method, params });
      },
      watch: { debounceMs: 30 },
    });
  }
  /** Simulates a crash + restart: the new worker has no workspace registered. */
  async restart(): Promise<void> {
    await this.handlers.dispose();
    this.handlers = this.spawn();
  }
  request<T>(method: string, params?: unknown): Promise<T> {
    const handler = (this.handlers as unknown as Record<string, (params: unknown) => Promise<unknown>>)[method];
    if (!handler) return Promise.reject(new Error(`unknown method ${method}`));
    return handler(params) as Promise<T>;
  }
  onNotify(listener: (event: WorkerNotify) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

let home: string;
let project: string;
let outside: string;
let dataDir: string;
let store: NovaStore;
let worker: InProcessWorker;
let workspaces: WorkspaceService;
let files: FilesService;
let picked: string | null;
let trashed: string[];

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(project, path)), { recursive: true });
  await writeFile(join(project, path), content);
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "nova-home-")));
  project = join(home, "code", "shop");
  await mkdir(project, { recursive: true });
  outside = await realpath(await mkdtemp(join(tmpdir(), "nova-outside-")));
  dataDir = await realpath(await mkdtemp(join(tmpdir(), "nova-data-")));
  store = openNovaStore(":memory:");
  worker = new InProcessWorker(await ripgrepPath());
  picked = project;
  trashed = [];
  const git = createGitClient({ env: gitEnv });
  workspaces = createWorkspaceService({
    repo: createWorkspaceRepo(store.db),
    editorState: createEditorStateRepo(store.db),
    pickFolder: async () => picked,
    homeDir: home,
    git,
    worker,
  });
  const checkpoints = createCheckpointsService({ workspaces, index: createCheckpointRepo(store.db), dataDir });
  files = createFilesService({
    workspaces,
    checkpoints: checkpoints.store,
    rgPath: await ripgrepPath(),
    trashItem: async (absolute) => {
      trashed.push(absolute);
      await rm(absolute, { recursive: true });
    },
  });
});
afterEach(async () => {
  await worker.handlers.dispose();
  store.close();
  for (const dir of [home, outside, dataDir]) await rm(dir, { recursive: true, force: true });
});

describe("workspace service", () => {
  it("opens a folder from the picker without leaking its absolute root, and lists recents", async () => {
    await put("package.json", JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^5" } }));
    await put("pnpm-lock.yaml", "");
    expect(await workspaces.api.open()).toMatchObject({ name: "shop", displayPath: join("~", "code", "shop") });
    picked = null;
    expect(await workspaces.api.open()).toBeNull();
    const [recent] = await workspaces.api.recent({ limit: 5 });
    expect(JSON.stringify(recent)).not.toContain(home);
    const id = recent?.id as string;

    const facts = await workspaces.api.facts({ workspaceId: id, refresh: false });
    expect(facts).toMatchObject({ packageManager: "pnpm", testRunner: { name: "vitest", command: ["pnpm", "run", "test"] }, git: false });
    await put("yarn.lock", "");
    await rm(join(project, "pnpm-lock.yaml"));
    expect((await workspaces.api.facts({ workspaceId: id, refresh: false })).packageManager).toBe("pnpm"); // cached
    expect((await workspaces.api.facts({ workspaceId: id, refresh: true })).packageManager).toBe("yarn");

    expect((await workspaces.api.setInstructionConsent({ workspaceId: id, consent: "allowed" })).instructionFilesConsent).toBe("allowed");
    await expect(workspaces.api.facts({ workspaceId: crypto.randomUUID(), refresh: false })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reopens a recent workspace by id and keeps its editor layout (paths only)", async () => {
    await put("a.txt", "hello");
    const { id } = (await workspaces.api.open()) as { id: string };
    await workspaces.api.close({ workspaceId: id });
    expect(await workspaces.api.reopen({ workspaceId: id })).toMatchObject({ id, name: "shop" });
    expect(await files.api.read({ workspaceId: id, path: "a.txt" })).toMatchObject({ content: "hello" });

    expect(await workspaces.api.getEditorState({ workspaceId: id })).toBeNull();
    const layout = { version: 1 as const, tabs: [{ path: "a.txt", pinned: true }], activePath: "a.txt", scroll: { "a.txt": 120 } };
    await workspaces.api.setEditorState({ workspaceId: id, state: layout });
    expect(await workspaces.api.getEditorState({ workspaceId: id })).toEqual(layout);
    await expect(workspaces.api.reopen({ workspaceId: crypto.randomUUID() })).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-registers the workspace after an fs-worker restart", async () => {
    await put("a.txt", "hello");
    const workspace = await workspaces.api.open();
    await worker.restart();
    const content = await files.api.read({ workspaceId: workspace?.id as string, path: "a.txt" });
    expect(content).toMatchObject({ content: "hello", hash: sha256("hello") });
  });
});

describe("files service", () => {
  it("maps refusals to IPC codes: outside, missing, conflict", async () => {
    await put("a.txt", "v1");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(project, "leak.txt"));
    const { id } = (await workspaces.api.open()) as { id: string };

    await expect(files.api.read({ workspaceId: id, path: "leak.txt" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(files.api.read({ workspaceId: id, path: "missing.txt" })).rejects.toMatchObject({ code: "not_found" });
    await expect(files.api.create({ workspaceId: id, path: "a.txt", kind: "file" })).rejects.toMatchObject({ code: "conflict" });
    await writeFile(join(project, "a.txt"), "changed on disk");
    expect(await files.api.write({ workspaceId: id, path: "a.txt", content: "mine", expectedHash: sha256("v1") })).toEqual({
      status: "conflict",
      path: "a.txt",
      currentHash: sha256("changed on disk"),
    });
    expect(await readFile(join(project, "a.txt"), "utf8")).toBe("changed on disk");
  });

  it("trashes through main after confinement, refusing escapes", async () => {
    await put("old.txt", "x");
    await mkdir(join(outside, "dir"));
    await writeFile(join(outside, "dir", "keep.txt"), "keep");
    await symlink(join(outside, "dir"), join(project, "linked"));
    const { id } = (await workspaces.api.open()) as { id: string };
    await files.api.trash({ workspaceId: id, path: "old.txt" });
    expect(trashed).toEqual([join(project, "old.txt")]);
    await expect(files.api.trash({ workspaceId: id, path: "linked/keep.txt" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await readFile(join(outside, "dir", "keep.txt"), "utf8")).toBe("keep");
  });

  it("pushes watcher batches for open workspaces", async () => {
    const { id } = (await workspaces.api.open()) as { id: string };
    const events: FilesEvent[] = [];
    const stop = files.onEvent((event) => events.push(event));
    await files.api.list({ workspaceId: id, path: "" });
    await new Promise((resolve) => setTimeout(resolve, 300)); // watcher initial scan
    await put("new.ts", "x");
    const deadline = Date.now() + 4_000;
    while (!events.some((event) => event.type === "changes" && event.changes.some((change) => change.path === "new.ts"))) {
      if (Date.now() > deadline) throw new Error("no event");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events[0]).toMatchObject({ workspaceId: id });
    stop();
  });
});

describe("search service", () => {
  it("searches text (with streaming) and quick-opens files", async () => {
    await put("src/cart.ts", "export const cartTotal = 0; // TODO\n");
    await put("src/checkout.ts", "// TODO later\n");
    const { id } = (await workspaces.api.open()) as { id: string };
    const search = createSearchService({ workspaces });
    const query = { workspaceId: id, pattern: "TODO", isRegex: false, caseSensitive: true, wholeWord: false, include: [], exclude: [], maxResults: 50 };
    expect((await search.api.text(query)).matches).toHaveLength(2);
    const streamed: SearchMatch[] = [];
    const result = await search.streamText(query, (matches) => streamed.push(...matches));
    expect(streamed.map((match) => match.path).sort()).toEqual(result.matches.map((match) => match.path).sort());
    expect((await search.api.files({ workspaceId: id, query: "ckout", limit: 5 })).paths).toEqual(["src/checkout.ts"]);
  });
});

describe("git service", () => {
  it("reports status and diffs of a repository, and unavailable for a plain folder", async () => {
    const { id } = (await workspaces.api.open()) as { id: string };
    const git = createGitService({ workspaces, git: createGitClient({ env: gitEnv }) });
    expect(await git.api.status({ workspaceId: id })).toEqual({ available: false });

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project, env: gitEnv });
    await put("a.txt", "one\n");
    const status = await git.api.status({ workspaceId: id });
    expect(status).toMatchObject({ available: true, branch: "main" });
    execFileSync("git", ["add", "."], { cwd: project, env: gitEnv });
    expect((await git.api.diff({ workspaceId: id, path: "a.txt", staged: true })).patch).toContain("+one");
  });
});

describe("checkpoints service with the agent file API", () => {
  it("restores a tool write and refuses to overwrite a later user change", async () => {
    await put("a.ts", "a1\n");
    await put("b.ts", "b1\n");
    const { id } = (await workspaces.api.open()) as { id: string };
    const checkpoints = createCheckpointsService({ workspaces, index: createCheckpointRepo(store.db), dataDir });
    const agentFiles = createFilesService({ workspaces, checkpoints: checkpoints.store, rgPath: null, trashItem: async () => {} });
    const ops = await agentFiles.fileOpsFor(id);
    const step = checkpoints.store.create({ workspaceId: id, missionId: null, label: "Étape 1", reason: "tool_write" });
    await ops.editFile("a.ts", [{ oldText: "a1", newText: "a2" }], { checkpointId: step.id });
    await ops.writeFile("b.ts", "b2\n", { expectedHash: sha256("b1\n"), checkpointId: step.id });
    await writeFile(join(project, "b.ts"), "b-user\n");

    const [listed] = await checkpoints.api.list({ workspaceId: id, missionId: null, limit: 10 });
    expect(listed?.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    const result = await checkpoints.api.restoreAll({ checkpointId: step.id });
    expect(result.results.map((entry) => entry.status)).toEqual(["restored", "conflict"]);
    expect(await readFile(join(project, "a.ts"), "utf8")).toBe("a1\n");
    expect(await readFile(join(project, "b.ts"), "utf8")).toBe("b-user\n");
    await expect(checkpoints.api.restoreFile({ checkpointId: crypto.randomUUID(), path: "a.ts" })).rejects.toMatchObject({ code: "not_found" });
    await expect(ops.searchText({ pattern: "x", isRegex: false, caseSensitive: false, wholeWord: false, include: [], exclude: [], maxResults: 1 })).rejects.toMatchObject({ code: "unavailable" });

    // The conflicting file: undo the agent's change on top of the user's version, then apply it.
    const proposal = await checkpoints.api.proposeMerge({ checkpointId: step.id, path: "b.ts" });
    expect(proposal).toEqual({
      status: "conflicting",
      path: "b.ts",
      currentHash: sha256("b-user\n"),
      base: "b2\n",
      current: "b-user\n",
      target: "b1\n",
    });
    // The user's hand merge is written only over the version it was made from.
    const merged = { checkpointId: step.id, path: "b.ts", merged: "b1 + user\n", expectedHash: sha256("b-user\n") };
    expect(await checkpoints.api.applyMerge(merged)).toMatchObject({ status: "restored" });
    expect(await readFile(join(project, "b.ts"), "utf8")).toBe("b1 + user\n");
    expect(await checkpoints.api.applyMerge(merged)).toMatchObject({ status: "conflict" });
  });

  it("records a project replace in a user restore point that restores every file", async () => {
    await put("a.ts", "old a\n");
    await put("b.ts", "old b\n");
    const { id } = (await workspaces.api.open()) as { id: string };
    const checkpoints = createCheckpointsService({ workspaces, index: createCheckpointRepo(store.db), dataDir });
    const userFiles = createFilesService({ workspaces, checkpoints: checkpoints.store, rgPath: null, trashItem: async () => {} });
    const point = await checkpoints.api.create({ workspaceId: id, label: "Remplacer « old »", reason: "user_replace" });
    for (const path of ["a.ts", "b.ts"]) {
      const current = await userFiles.api.read({ workspaceId: id, path });
      const next = (current.content ?? "").replace("old", "new");
      expect(await userFiles.api.write({ workspaceId: id, path, content: next, expectedHash: current.hash, checkpointId: point.id })).toMatchObject({ status: "written" });
    }
    // A stale hash writes nothing and records nothing.
    expect(await userFiles.api.write({ workspaceId: id, path: "a.ts", content: "x", expectedHash: sha256("old a\n"), checkpointId: point.id })).toMatchObject({ status: "conflict" });
    const [listed] = await checkpoints.api.list({ workspaceId: id, missionId: null, limit: 5 });
    expect(listed?.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    await checkpoints.api.restoreAll({ checkpointId: point.id });
    expect(await readFile(join(project, "a.ts"), "utf8")).toBe("old a\n");
    expect(await readFile(join(project, "b.ts"), "utf8")).toBe("old b\n");
    // An agent checkpoint cannot be used by the renderer's write.
    const agentPoint = checkpoints.store.create({ workspaceId: id, missionId: null, label: "Étape", reason: "tool_write" });
    await expect(userFiles.api.write({ workspaceId: id, path: "a.ts", content: "y", expectedHash: null, checkpointId: agentPoint.id })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

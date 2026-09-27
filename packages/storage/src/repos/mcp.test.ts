import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createMcpRepo, type NewMcpServer } from "./mcp";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1000;
  store = openNovaStore(":memory:");
});
afterEach(() => {
  store.close();
});

const stdio = (name: string, workspaceId: string | null = null): NewMcpServer => ({
  name,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: { TOKEN: { kind: "secret_ref", secretRef: "s1", hint: "abcd" }, MODE: { kind: "plain", value: "x" } },
  },
  scope: workspaceId ? "workspace" : "global",
  workspaceId,
  enabled: true,
});

describe("mcp repo", () => {
  it("round-trips servers, scopes the list and enforces unique names per scope", () => {
    const repo = createMcpRepo(store.db, now);
    const workspace = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/home/u/a", name: "a" });
    const global = repo.insertServer(stdio("fs"));
    const local = repo.insertServer(stdio("fs", workspace.id));

    expect(repo.getServer(global.id)).toEqual(global);
    expect(global.transport).toEqual(stdio("fs").transport);
    expect(repo.listServers(null).map((server) => server.id)).toEqual([global.id]);
    expect(repo.listServers(workspace.id).map((server) => server.id).sort()).toEqual([global.id, local.id].sort());
    expect(repo.findServerByName(workspace.id, "fs")?.id).toBe(local.id);
    expect(repo.findServerByName(null, "fs")?.id).toBe(global.id);
    expect(() => repo.insertServer(stdio("fs"))).toThrow(/UNIQUE/);

    const updated = repo.updateServer(global.id, { enabled: false, name: "files" });
    expect(updated).toMatchObject({ name: "files", enabled: false, transport: global.transport });
    expect(repo.updateServer("missing", { enabled: true })).toBeNull();
    expect(repo.deleteServer(global.id)).toBe(true);
    expect(repo.deleteServer(global.id)).toBe(false);
  });

  it("upserts tool permissions per workspace target and cascades on delete", () => {
    const repo = createMcpRepo(store.db, now);
    const workspace = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/home/u/a", name: "a" });
    const server = repo.insertServer(stdio("fs"));
    repo.setToolPermission(server.id, "read_file", null, "allow");
    repo.setToolPermission(server.id, "read_file", null, "deny");
    repo.setToolPermission(server.id, "read_file", workspace.id, "ask");

    expect(repo.listToolPermissions(server.id).map((rule) => [rule.workspaceId, rule.permission])).toEqual(
      expect.arrayContaining([
        [null, "deny"],
        [workspace.id, "ask"],
      ]),
    );
    expect(repo.listToolPermissions(server.id)).toHaveLength(2);

    repo.replaceCachedTools(server.id, [
      { name: "b", description: null, inputSchema: { type: "object" }, annotations: null },
      { name: "a", description: "reads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]);
    repo.replaceCachedTools(server.id, [
      { name: "z", description: "only", inputSchema: { type: "object" }, annotations: null },
      { name: "a", description: "reads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ]);
    expect(repo.listCachedTools(server.id).map((tool) => tool.name)).toEqual(["a", "z"]);
    expect(repo.listCachedTools(server.id)[0]?.annotations).toEqual({ readOnlyHint: true });

    repo.deleteServer(server.id);
    expect(repo.listToolPermissions(server.id)).toEqual([]);
    expect(repo.listCachedTools(server.id)).toEqual([]);
  });
});

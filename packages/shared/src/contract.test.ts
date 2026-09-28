// J2-A shared contract: path validation, tool naming, request schemas and the port registry.
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  CompanionActionSchema,
  FileWriteRequestSchema,
  McpServerInputSchema,
  MissionPlanRequestSchema,
  RelativePathSchema,
  SearchTextRequestSchema,
  WebPolicySetRequestSchema,
  createNovaPortRegistry,
  isCanonicalRelativePath,
  isMcpToolName,
  isTerminalMissionEvent,
  isToolName,
  joinRelativePath,
  mcpToolName,
  parentRelativePath,
  parseMcpToolName,
  type MissionEvent,
} from "./index";

const ID = "7f1c1b8e-7a8f-4d7c-9a51-1c2c3d4e5f60";
const HASH = "a".repeat(64);

describe("relative paths", () => {
  it.each(["", "a", "src/app.ts", "a/b/c.d", ".env", "dir/.hidden", "é/ü.md", "a..b/c"])("accepts %j", (path) => {
    expect(isCanonicalRelativePath(path)).toBe(true);
    expect(RelativePathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    "..",
    "../x",
    "a/../b",
    "a/..",
    ".",
    "./a",
    "a/./b",
    "/etc/passwd",
    "a/",
    "a//b",
    "a\\b",
    "..\\x",
    "C:/Windows",
    "c:",
    "a\0b",
    `${"x".repeat(256)}`,
    "a/".repeat(2_100),
  ])("rejects %j", (path) => {
    expect(isCanonicalRelativePath(path)).toBe(false);
    expect(RelativePathSchema.safeParse(path).success).toBe(false);
  });

  it("joins and splits canonical paths", () => {
    expect(joinRelativePath("", "a")).toBe("a");
    expect(joinRelativePath("a/b", "c")).toBe("a/b/c");
    expect(parentRelativePath("a/b/c")).toBe("a/b");
    expect(parentRelativePath("a")).toBe("");
  });
});

describe("tool names", () => {
  it("keeps the builtin order and recognizes MCP names", () => {
    expect(BUILTIN_TOOL_NAMES[0]).toBe("read_file");
    expect(new Set(BUILTIN_TOOL_NAMES).size).toBe(BUILTIN_TOOL_NAMES.length);
    expect(isToolName("edit_file")).toBe(true);
    expect(isToolName("rm_rf")).toBe(false);
    const name = mcpToolName("File System", "read_text_file");
    expect(name).toBe("mcp__File-System__read-text-file");
    expect(name && isMcpToolName(name)).toBe(true);
    expect(parseMcpToolName("mcp__File-System__read-text-file")).toEqual({
      serverSlug: "File-System",
      toolSlug: "read-text-file",
    });
    // Provider limit: ^[a-zA-Z0-9_-]{1,64}$
    for (const candidate of [name ?? "", ...BUILTIN_TOOL_NAMES]) expect(candidate).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(mcpToolName("s".repeat(40), "t".repeat(40))).toBeNull();
    expect(isMcpToolName("mcp__a__b__c")).toBe(false);
  });
});

describe("request schemas", () => {
  it("bounds file writes and requires a hash or null", () => {
    const base = { workspaceId: ID, path: "src/a.ts", content: "x" };
    expect(FileWriteRequestSchema.safeParse({ ...base, expectedHash: HASH }).success).toBe(true);
    expect(FileWriteRequestSchema.safeParse({ ...base, expectedHash: null }).success).toBe(true);
    expect(FileWriteRequestSchema.safeParse({ ...base }).success).toBe(false);
    expect(FileWriteRequestSchema.safeParse({ ...base, expectedHash: "abc" }).success).toBe(false);
    expect(FileWriteRequestSchema.safeParse({ ...base, path: "", expectedHash: null }).success).toBe(false);
  });

  it("validates search, mission, MCP, web and companion payloads", () => {
    const search = {
      workspaceId: ID,
      pattern: "TODO",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      include: ["src/**"],
      exclude: [],
      maxResults: 500,
    };
    expect(SearchTextRequestSchema.safeParse(search).success).toBe(true);
    expect(SearchTextRequestSchema.safeParse({ ...search, maxResults: 1_000_000 }).success).toBe(false);

    const plan = { workspaceId: ID, conversationId: null, goal: "Fix cart", mode: "fix", modelId: "a/b", contract: null };
    expect(MissionPlanRequestSchema.safeParse(plan).success).toBe(true);
    expect(MissionPlanRequestSchema.safeParse({ ...plan, mode: "yolo" }).success).toBe(false);

    const server = {
      name: "fs",
      transport: { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: { kind: "secret", value: "s3cr3t" } } },
      scope: "global",
      workspaceId: null,
      enabled: true,
    };
    expect(McpServerInputSchema.safeParse(server).success).toBe(true);
    expect(McpServerInputSchema.safeParse({ ...server, scope: "workspace" }).success).toBe(false);
    expect(
      McpServerInputSchema.safeParse({ ...server, transport: { type: "http", url: "file:///etc", headers: {} } }).success,
    ).toBe(false);

    const web = { workspaceId: null, defaultAction: "ask", rules: [{ pattern: "*.mozilla.org", action: "allow" }], preset: null };
    expect(WebPolicySetRequestSchema.safeParse(web).success).toBe(true);
    expect(
      WebPolicySetRequestSchema.safeParse({ ...web, rules: [{ pattern: "http://x.com/a", action: "allow" }] }).success,
    ).toBe(false);

    expect(CompanionActionSchema.safeParse({ type: "open_diff", missionId: ID, path: "../x" }).success).toBe(false);
    expect(CompanionActionSchema.safeParse({ type: "stop_mission", missionId: ID }).success).toBe(true);
  });

  it("identifies terminal mission events", () => {
    const base = { id: ID, missionId: ID, seq: 1, at: 0 };
    const done: MissionEvent = { ...base, type: "mission.succeeded", summary: "ok" };
    const plan: MissionEvent = { ...base, type: "mission.plan", summary: "", tasks: [] };
    expect(isTerminalMissionEvent(done)).toBe(true);
    expect(isTerminalMissionEvent(plan)).toBe(false);
  });
});

describe("port registry", () => {
  function post(target: EventTarget, data: unknown, ports: MessagePort[]): void {
    target.dispatchEvent(new MessageEvent("message", { data, ports }));
  }

  it("hands a port to its taker, buffering ports that arrive first", async () => {
    const target = new EventTarget();
    const registry = createNovaPortRegistry(target as unknown as Window);
    const early = new MessageChannel();
    post(target, { type: "nova:port", kind: "terminal", id: "a" }, [early.port1]);
    await expect(registry.take("terminal", "a")).resolves.toBe(early.port1);

    const late = new MessageChannel();
    const pending = registry.take("terminal", "b");
    post(target, { type: "nova:port", kind: "terminal", id: "b" }, [late.port1]);
    await expect(pending).resolves.toBe(late.port1);

    // Wrong shape or no port: ignored.
    post(target, { type: "other", kind: "terminal", id: "c" }, [new MessageChannel().port1]);
    await expect(registry.take("terminal", "c", 20)).rejects.toThrow(/No terminal port/);
    registry.dispose();
    for (const channel of [early, late]) {
      channel.port1.close();
      channel.port2.close();
    }
  });
});

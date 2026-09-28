// Injection interfaces the executors adapt. Executors never touch the disk, a process, git or the
// network themselves: main passes implementations that already enforce confinement (S2), the
// domain policy (W4) and the MCP rules (M5). The shapes are the ones the owning lanes built, so
// their services plug in structurally, without adapters:
// - files: `@nova/workspace` `WorkspaceFileOps` (files-service `fileOpsFor(workspaceId)`, L2);
// - git: git-service `api.status/api.diff` + `commit` (L2);
// - web: `WebService` (L4);
// - mcp: `McpService` (L5).
import type {
  ContentHash,
  FetchedPage,
  FileEntry,
  GitDiff,
  GitStatus,
  IsolationLevel,
  McpToolName,
  RelativePath,
  SearchQuery,
  SearchResult,
  ToolDefinition,
  ToolResult,
  WebCitation,
  WorkspaceFacts,
} from "@nova/shared";

// ---------------------------------------------------------------------------
// Files (L2 WorkspaceFileOps, bound to one workspace)

export interface FileReadOutcome {
  path: RelativePath;
  hash: ContentHash;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  /** The range was cut at TOOL_LIMITS.readMaxChars. */
  truncated: boolean;
}

export type FileChangeOutcome =
  | {
      status: "written";
      path: RelativePath;
      hash: ContentHash;
      size: number;
      created: boolean;
      additions: number;
      deletions: number;
      checkpointId: string;
      excerpt: { startLine: number; text: string } | null;
    }
  | { status: "conflict"; path: RelativePath; currentHash: ContentHash | null };

/**
 * Confined file operations of ONE workspace. Every path is checked against the root and the C8
 * exclusions; writes take the hash the agent last saw (null = must not exist) and never overwrite
 * on mismatch; every change is snapshotted into the given checkpoint first (A10).
 */
export interface WorkspaceFileApi {
  readFile(path: RelativePath, range?: { startLine?: number; endLine?: number }): Promise<FileReadOutcome>;
  list(path: RelativePath): Promise<FileEntry[]>;
  glob(pattern: string, limit: number): Promise<{ paths: RelativePath[]; truncated: boolean }>;
  searchText(query: Omit<SearchQuery, "workspaceId">, signal?: AbortSignal): Promise<SearchResult>;
  writeFile(path: RelativePath, content: string, options: { expectedHash: ContentHash | null; checkpointId: string }): Promise<FileChangeOutcome>;
  editFile(
    path: RelativePath,
    edits: readonly { oldText: string; newText: string }[],
    options: { expectedHash?: ContentHash; checkpointId: string },
  ): Promise<FileChangeOutcome>;
  move(from: RelativePath, to: RelativePath, options: { checkpointId: string }): Promise<FileEntry>;
  /** OS trash, never a permanent delete; content checkpointed first. */
  trash(path: RelativePath, options: { checkpointId: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Commands

export interface CommandSpec {
  workspaceId: string;
  missionId: string;
  argv: string[];
  /** Relative to the workspace root; the runner resolves and contains it (S2). */
  cwd: RelativePath;
  timeoutMs: number;
  /** Extra non-secret variables (e.g. `CI=1`); secret-looking names are refused. */
  env?: Readonly<Record<string, string>>;
}

export interface CommandOutcome {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Last bytes of combined stdout+stderr (bounded by TOOL_LIMITS.commandOutputMaxBytes). */
  output: string;
  /** Total bytes produced (may exceed what was kept). */
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  isolationLevel: IsolationLevel;
}

export interface BackgroundProcess {
  id: string;
  missionId: string;
  argv: string[];
  cwd: RelativePath;
  pid: number | null;
  startedAt: number;
  state: "running" | "exited";
  exitCode: number | null;
}

export type CommandOutputListener = (stream: "stdout" | "stderr", chunk: string) => void;

/** Structured process execution: no shell, confined cwd, scrubbed env, timeout, caps, tree kill. */
export interface CommandRunner {
  run(spec: CommandSpec, signal: AbortSignal, onOutput?: CommandOutputListener): Promise<CommandOutcome>;
  /** Starts a long-lived process (dev server); returns once it runs, with its first output. */
  startBackground(
    spec: CommandSpec,
    onOutput?: CommandOutputListener,
  ): Promise<{ process: BackgroundProcess; initialOutput: string; isolationLevel: IsolationLevel }>;
  list(missionId: string): BackgroundProcess[];
  /** Kills the process tree; resolves when it exited. Idempotent. */
  stop(processId: string): Promise<void>;
  /** Kills every process of the mission (mission stop). Idempotent. */
  stopAll(missionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Git (L2 git-service)

export interface GitApi {
  status(req: { workspaceId: string }): Promise<GitStatus>;
  diff(req: { workspaceId: string; path: RelativePath | null; staged: boolean }): Promise<GitDiff>;
  /**
   * Commits the given paths (`"all"` = every change under the workspace, untracked files included;
   * refused when it would include an excluded file). Never pushes.
   */
  commit(workspaceId: string, request: { message: string; paths: RelativePath[] | "all" }): Promise<{ sha: string; files: RelativePath[] }>;
}

// ---------------------------------------------------------------------------
// Web (L4 WebService)

/** Where a web call happens: the workspace policy applies, the mission hosts restrict (W4). */
export interface WebCallContext {
  workspaceId: string | null;
  /** Hosts the mission contract allows; null = no extra restriction. */
  missionHosts: readonly string[] | null;
}

export interface WebApi {
  /** Domain policy for a URL (throws on an invalid or blocked URL). */
  decide(url: string, context: WebCallContext): { action: "allow" | "ask" | "deny"; host: string };
  /** Throws a `{ code }` error (`policy_ask`, `policy_denied`, `blocked_address`, `timeout`…). */
  fetchPage(input: {
    url: string;
    context: WebCallContext;
    /** Hosts approved for this call (the permission step covered them). */
    approvedHosts?: readonly string[];
    signal: AbortSignal;
  }): Promise<{ page: FetchedPage; content: string }>;
  webSearch(input: {
    query: string;
    context: WebCallContext;
    maxResults?: number;
    usageRef: { conversationId: string | null; messageId: string | null; missionId: string | null; toolCallId: string | null };
    signal: AbortSignal;
  }): Promise<{ result: { query: string; citations: WebCitation[]; costUsd: number | null }; content: string }>;
}

// ---------------------------------------------------------------------------
// MCP (L5 McpService)

/** An enabled MCP tool as offered to the model (never a `deny` tool nor a disabled server). */
export interface McpToolOffer {
  definition: ToolDefinition & { name: McpToolName };
  serverName: string;
  toolName: string;
  /** Per-tool permission set in the MCP manager; `ask` makes every call ask (mcp_tool_policy). */
  permission: "allow" | "ask";
}

export interface McpApi {
  listToolsForModel(workspaceId: string): Promise<McpToolOffer[]>;
  /** `approved`: the gateway allowed or the user approved this exact call. Returns untrusted output. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    context: { workspaceId: string; callId: string; signal: AbortSignal; approved: boolean },
  ): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------

/** Everything the executors of one workspace need. Missing capabilities make their tools `unavailable`. */
export interface ToolDeps {
  files: WorkspaceFileApi;
  /** Detected project facts (test runner…); null = unknown. */
  facts(): Promise<WorkspaceFacts | null>;
  commands: CommandRunner | null;
  git: GitApi | null;
  web: WebApi | null;
  mcp: McpApi | null;
}

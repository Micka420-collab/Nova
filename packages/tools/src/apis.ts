// Injection interfaces the executors adapt. Executors never touch the disk, a process, git or the
// network themselves: main passes implementations that already enforce confinement (S2), the
// domain policy (W4) and the MCP rules (M5). Shapes mirror the NovaApi request types so the main
// services of the workspace (L2), web (L4) and MCP (L5) lanes plug in without adapters.
import type {
  FetchedPage,
  FileContent,
  FileEntry,
  FileWriteResult,
  FilesListRequest,
  FilesMoveRequest,
  FilesReadRequest,
  FilesTrashRequest,
  FileWriteRequest,
  GitDiff,
  GitDiffRequest,
  GitStatus,
  IsolationLevel,
  McpToolInfo,
  McpToolName,
  RelativePath,
  SearchQuery,
  SearchResult,
  WebSearchResult,
  WorkspaceFacts,
  WorkspaceFactsRequest,
  WorkspaceIdRequest,
} from "@nova/shared";

/** Confined workspace filesystem (main → fs-worker). Paths are canonical relative paths. */
export interface WorkspaceFsApi {
  list(req: FilesListRequest): Promise<FileEntry[]>;
  read(req: FilesReadRequest): Promise<FileContent>;
  /** Optimistic concurrency: a hash mismatch returns `conflict` and writes nothing. */
  write(req: FileWriteRequest): Promise<FileWriteResult>;
  move(req: FilesMoveRequest): Promise<FileEntry>;
  /** OS trash, never a permanent delete. */
  trash(req: FilesTrashRequest): Promise<void>;
  searchText(req: SearchQuery, signal: AbortSignal): Promise<SearchResult>;
  /** Files matching a gitignore-style glob (ripgrep `--files -g`), ignored files excluded. */
  glob(req: { workspaceId: string; pattern: string; limit: number }, signal: AbortSignal): Promise<{ paths: RelativePath[]; truncated: boolean }>;
  facts(req: WorkspaceFactsRequest): Promise<WorkspaceFacts>;
}

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

/** System git CLI (L2/A5). */
export interface GitApi {
  status(req: WorkspaceIdRequest): Promise<GitStatus>;
  diff(req: GitDiffRequest): Promise<GitDiff>;
  /** Commits the given paths (all tracked changes when empty). Never pushes. */
  commit(req: { workspaceId: string; message: string; paths: RelativePath[] }): Promise<{ sha: string }>;
}

/** Internet access from main (L4): the domain policy and SSRF guard are applied inside. */
export interface WebApi {
  search(
    req: { workspaceId: string; missionId: string; query: string; maxResults: number; includeDomains: string[]; excludeDomains: string[] },
    signal: AbortSignal,
  ): Promise<WebSearchResult>;
  fetchPage(req: { workspaceId: string; missionId: string; url: string }, signal: AbortSignal): Promise<FetchedPage>;
}

export interface McpCallOutcome {
  isError: boolean;
  /** Text content of the result (already capped by the MCP host). Untrusted. */
  text: string;
  server: string;
}

/** MCP tools (L5): only enabled tools with a model-facing name are listed. */
export interface McpApi {
  listTools(workspaceId: string): Promise<McpToolInfo[]>;
  callTool(
    req: { workspaceId: string; missionId: string; name: McpToolName; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<McpCallOutcome>;
}

/** Everything the built-in executors need. Missing capabilities make their tools `unavailable`. */
export interface ToolDeps {
  fs: WorkspaceFsApi;
  commands: CommandRunner | null;
  git: GitApi | null;
  web: WebApi | null;
  mcp: McpApi | null;
}

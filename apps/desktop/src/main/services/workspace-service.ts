// Workspace registry in main (E1): folder picker, recent list, facts cache, D10 consent, and the
// fs-worker client shared by the files/search services. The absolute root never leaves main: the
// renderer gets `displayPath` (home-abbreviated, display only) and uses workspace ids.
import { basename, sep } from "node:path";
import type { Workspace, WorkspaceFacts } from "@nova/shared";
import type { WorkspaceRecord, WorkspaceRepo } from "@nova/storage";
import { WorkspaceError, canonicalRoot, detectWorkspaceFacts, type GitClient } from "@nova/workspace";
import type { IpcErrorCode } from "@nova/shared";
import { ServiceError } from "../service-error";
import type { WorkerNotify } from "../../workers/protocol";
import type { FsMethod, FsMethods, FsOutcome } from "../../workers/fs/protocol";
import type { AtelierApi } from "./unavailable";

// ---------------------------------------------------------------------------
// Errors

const IPC_CODE_BY_WORKSPACE_CODE: Readonly<Record<string, IpcErrorCode>> = {
  not_found: "not_found",
  conflict: "conflict",
  already_exists: "conflict",
  unavailable: "unavailable",
  cancelled: "unavailable",
  not_open: "unavailable",
  failed: "internal",
};

/** Maps a workspace-layer refusal to the IPC error the renderer understands (messages are path-free). */
export function toServiceError(code: string, message: string): ServiceError {
  return new ServiceError(IPC_CODE_BY_WORKSPACE_CODE[code] ?? "invalid_request", message);
}

/** Rethrows WorkspaceError as ServiceError; anything else unchanged. */
export async function asService<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof WorkspaceError) throw toServiceError(error.code, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// fs-worker client

/** What the services need from the fs-worker (ManagedWorker satisfies it). */
export interface FsWorkerPort {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotify(listener: (event: WorkerNotify) => void): () => void;
}

export interface FsClient {
  call<M extends FsMethod>(method: M, params: FsMethods[M]["params"]): Promise<FsMethods[M]["result"]>;
  onNotify(listener: (event: WorkerNotify) => void): () => void;
  /** Registers a workspace root with the worker (idempotent). */
  open(workspaceId: string, root: string): Promise<void>;
  close(workspaceId: string): Promise<void>;
}

export function createFsClient(worker: FsWorkerPort, rootOf: (workspaceId: string) => Promise<string>): FsClient {
  const unwrap = <T>(outcome: FsOutcome<T>): T => {
    if (outcome.ok) return outcome.value;
    throw toServiceError(outcome.code, outcome.message);
  };
  const raw = <M extends FsMethod>(method: M, params: FsMethods[M]["params"]): Promise<FsOutcome<FsMethods[M]["result"]>> =>
    worker.request<FsOutcome<FsMethods[M]["result"]>>(method, params);

  const client: FsClient = {
    async call(method, params) {
      const first = await raw(method, params);
      // A restarted worker lost its registrations: register again, retry once.
      if (!first.ok && first.code === "not_open" && typeof params === "object" && params !== null && "workspaceId" in params) {
        const { workspaceId } = params as { workspaceId: string };
        await client.open(workspaceId, await rootOf(workspaceId));
        return unwrap(await raw(method, params));
      }
      return unwrap(first);
    },
    onNotify: (listener) => worker.onNotify(listener),
    async open(workspaceId, root) {
      unwrap(await raw("workspace.open", { workspaceId, root }));
    },
    async close(workspaceId) {
      unwrap(await raw("workspace.close", { workspaceId }));
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Workspace service

export interface WorkspaceServiceDeps {
  repo: WorkspaceRepo;
  /** Native folder picker (dialog.showOpenDialog in main); null when cancelled. */
  pickFolder: () => Promise<string | null>;
  /** User home, for the display-only `~/…` path. */
  homeDir: string;
  git: Pick<GitClient, "isRepo">;
  /** fs-worker (started lazily by the pool). */
  worker: FsWorkerPort;
  now?: () => number;
}

export interface WorkspaceService {
  api: AtelierApi["workspace"];
  fs: FsClient;
  /** Canonical root of a known workspace (main only). `not_found` when unknown or gone. */
  rootOf(workspaceId: string): Promise<string>;
  /** Reopens a recent workspace by id (bumps lastOpenedAt, registers it with the worker). */
  reopen(workspaceId: string): Promise<Workspace>;
}

export function displayPath(root: string, homeDir: string): string {
  if (homeDir && (root === homeDir || root.startsWith(homeDir + sep))) return `~${root.slice(homeDir.length)}`;
  return root;
}

function toWorkspace(record: WorkspaceRecord, homeDir: string): Workspace {
  return {
    id: record.id,
    name: record.name,
    displayPath: displayPath(record.rootPath, homeDir),
    permissionProfile: record.permissionProfile,
    instructionFilesConsent: record.instructionFilesConsent,
    createdAt: record.createdAt,
    lastOpenedAt: record.lastOpenedAt,
  };
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const { repo, homeDir } = deps;

  const record = (workspaceId: string): WorkspaceRecord => {
    const found = repo.get(workspaceId);
    if (!found) throw new ServiceError("not_found", "Workspace not found");
    return found;
  };

  const rootOf = async (workspaceId: string): Promise<string> => {
    const { rootPath } = record(workspaceId);
    // The folder may have been moved or deleted since it was opened.
    return asService(canonicalRoot(rootPath));
  };

  const fs = createFsClient(deps.worker, rootOf);

  const detect = async (workspaceId: string): Promise<WorkspaceFacts> => {
    const root = await rootOf(workspaceId);
    const facts = await detectWorkspaceFacts(root, workspaceId, {
      isGitRepo: (folder) => deps.git.isRepo(folder),
      ...(deps.now ? { now: deps.now } : {}),
    });
    repo.putFacts(facts);
    return facts;
  };

  return {
    fs,
    rootOf,
    async reopen(workspaceId) {
      const root = await rootOf(workspaceId);
      const opened = repo.upsertByRootPath({ rootPath: root, name: basename(root) || root });
      await fs.open(opened.id, root);
      return toWorkspace(opened, homeDir);
    },
    api: {
      async open() {
        const picked = await deps.pickFolder();
        if (picked === null) return null;
        const root = await asService(canonicalRoot(picked));
        const opened = repo.upsertByRootPath({ rootPath: root, name: basename(root) || root });
        await fs.open(opened.id, root);
        return toWorkspace(opened, homeDir);
      },

      async recent({ limit }) {
        return repo.listRecent(limit).map((entry) => toWorkspace(entry, homeDir));
      },

      async facts({ workspaceId, refresh }) {
        record(workspaceId);
        if (!refresh) {
          const cached = repo.getFacts(workspaceId);
          if (cached) return cached;
        }
        return detect(workspaceId);
      },

      async close({ workspaceId }) {
        record(workspaceId);
        await fs.close(workspaceId);
      },

      async setInstructionConsent({ workspaceId, consent }) {
        const updated = repo.setInstructionFilesConsent(workspaceId, consent);
        if (!updated) throw new ServiceError("not_found", "Workspace not found");
        return toWorkspace(updated, homeDir);
      },
    },
  };
}

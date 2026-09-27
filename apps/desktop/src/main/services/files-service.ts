// files.* in main (E1/E2): list/read/write/create/move run in the fs-worker; trash runs here
// because `shell.trashItem` is main-only (the path is confined first). Watch batches from the
// worker are fanned out to `onEvent` listeners (the push channel to the renderer).
import type { FilesEvent } from "@nova/shared";
import {
  createIgnoreMatcher,
  createWorkspaceFileOps,
  resolveEntry,
  type CheckpointStore,
  type WorkspaceFileOps,
} from "@nova/workspace";
import { FS_NOTIFY } from "../../workers/fs/protocol";
import type { AtelierApi } from "../api";
import { ServiceError } from "../service-error";
import { asService, type WorkspaceService } from "./workspace-service";

export interface FilesServiceDeps {
  workspaces: Pick<WorkspaceService, "fs" | "rootOf">;
  /** `shell.trashItem` (never a permanent delete). */
  trashItem: (absolutePath: string) => Promise<void>;
  /** Agent file tools (A2): checkpointed writes, ripgrep for search_text (null = unavailable). */
  checkpoints: CheckpointStore;
  rgPath: string | null;
}

export interface FilesService {
  api: AtelierApi["files"];
  /** FilesEvent stream for the renderer push channel. Returns an unsubscribe function. */
  onEvent(listener: (event: FilesEvent) => void): () => void;
  /**
   * In-process file API for the agent tools of one workspace (cached per root). Permissions are
   * NOT evaluated here: the tools lane evaluates them in main before calling.
   */
  fileOpsFor(workspaceId: string): Promise<WorkspaceFileOps>;
}

export function createFilesService(deps: FilesServiceDeps): FilesService {
  const { fs } = deps.workspaces;
  const agentOps = new Map<string, { root: string; ops: WorkspaceFileOps }>();
  return {
    async fileOpsFor(workspaceId) {
      const root = await deps.workspaces.rootOf(workspaceId);
      const cached = agentOps.get(workspaceId);
      if (cached?.root === root) return cached.ops;
      const ops = createWorkspaceFileOps({
        workspaceId,
        root,
        matcher: createIgnoreMatcher(root),
        checkpoints: deps.checkpoints,
        rgPath: deps.rgPath,
        trash: deps.trashItem,
      });
      agentOps.set(workspaceId, { root, ops });
      return ops;
    },
    api: {
      list: (req) => fs.call("files.list", req),
      read: (req) => fs.call("files.read", req),
      async write({ checkpointId, ...req }) {
        if (!checkpointId) return fs.call("files.write", req);
        // E4 project replace: the previous content goes into the user's restore point first.
        const checkpoint = deps.checkpoints.get(checkpointId);
        const usable =
          checkpoint !== null &&
          checkpoint.workspaceId === req.workspaceId &&
          checkpoint.missionId === null &&
          (checkpoint.reason === "user_replace" || checkpoint.reason === "manual");
        if (!usable) throw new ServiceError("invalid_request", "Checkpoint cannot record this write");
        const root = await deps.workspaces.rootOf(req.workspaceId);
        const pending = await asService(
          deps.checkpoints.snapshotBeforeWrite({ checkpointId, root, path: req.path, seenHash: req.expectedHash }),
        );
        try {
          const result = await fs.call("files.write", req);
          if (result.status === "written") await pending.commit(req.content);
          else pending.discard();
          return result;
        } catch (error) {
          pending.discard();
          throw error;
        }
      },
      create: (req) => fs.call("files.create", req),
      move: (req) => fs.call("files.move", req),
      async trash({ workspaceId, path }) {
        const root = await deps.workspaces.rootOf(workspaceId);
        const absolute = await asService(resolveEntry(root, path));
        await deps.trashItem(absolute);
      },
    },
    onEvent(listener) {
      return fs.onNotify((event) => {
        if (event.method === FS_NOTIFY.filesEvent) listener(event.params as FilesEvent);
      });
    },
  };
}

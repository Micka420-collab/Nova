// checkpoints.* in main (A10/A11): list, restore one file, restore all, plus the merge proposal
// shown when a restore meets a file the user changed since. The store (object files + rows) lives
// in main because it shares the database; roots come from the workspace registry.
import type { ContentHash, RelativePath, RestoreFileResult } from "@nova/shared";
import {
  createCheckpointStore,
  createObjectStore,
  type CheckpointIndex,
  type CheckpointStore,
  type MergeProposal,
  type PurgeReport,
  type RetentionPolicy,
} from "@nova/workspace";
import { join } from "node:path";
import { ServiceError } from "../service-error";
import type { AtelierApi } from "./unavailable";
import { asService, type WorkspaceService } from "./workspace-service";

/** A10 proposal: 30 days or 2 GB, whichever comes first. */
export const DEFAULT_CHECKPOINT_RETENTION: RetentionPolicy = {
  maxAgeMs: 30 * 24 * 60 * 60_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
};

/** dataDir/checkpoints/objects, as documented in the storage migration. */
export function checkpointObjectsDir(dataDir: string): string {
  return join(dataDir, "checkpoints", "objects");
}

export interface CheckpointsService {
  api: AtelierApi["checkpoints"];
  /** Shared with the agent tools (snapshotBeforeWrite, create…). */
  store: CheckpointStore;
  proposeMerge(checkpointId: string, path: RelativePath): Promise<MergeProposal>;
  applyMerge(input: { checkpointId: string; path: RelativePath; merged: string; expectedHash: ContentHash | null }): Promise<RestoreFileResult>;
  purge(policy?: RetentionPolicy): Promise<PurgeReport>;
}

export interface CheckpointsServiceDeps {
  workspaces: Pick<WorkspaceService, "rootOf">;
  /** @nova/storage `createCheckpointRepo(store.db)`. */
  index: CheckpointIndex;
  dataDir: string;
  now?: () => number;
}

export function createCheckpointsService(deps: CheckpointsServiceDeps): CheckpointsService {
  const store = createCheckpointStore({
    index: deps.index,
    objects: createObjectStore(checkpointObjectsDir(deps.dataDir)),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const rootFor = async (checkpointId: string): Promise<string> => {
    const checkpoint = store.get(checkpointId);
    if (!checkpoint) throw new ServiceError("not_found", "Checkpoint not found");
    return deps.workspaces.rootOf(checkpoint.workspaceId);
  };

  return {
    store,
    api: {
      list: async (req) => store.list(req),
      restoreFile: async ({ checkpointId, path }) =>
        asService(store.restoreFile({ checkpointId, path, root: await rootFor(checkpointId) })),
      restoreAll: async ({ checkpointId }) => asService(store.restoreAll({ checkpointId, root: await rootFor(checkpointId) })),
    },
    proposeMerge: async (checkpointId, path) =>
      asService(store.proposeMerge({ checkpointId, path, root: await rootFor(checkpointId) })),
    applyMerge: async (input) => asService(store.applyMerge({ ...input, root: await rootFor(input.checkpointId) })),
    purge: (policy = DEFAULT_CHECKPOINT_RETENTION) => store.purge(policy),
  };
}

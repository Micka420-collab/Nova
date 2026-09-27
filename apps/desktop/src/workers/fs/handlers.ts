// fs-worker method handlers, independent of Electron (tested in-process from the main services).
// One entry per open workspace: its canonical root, ignore matcher, chokidar watcher and quick-open
// index. Watch batches are pushed to main as `files.event` notifications.
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  FileWriteRequestSchema,
  FilesCreateRequestSchema,
  FilesListRequestSchema,
  FilesMoveRequestSchema,
  FilesReadRequestSchema,
  SearchFilesRequestSchema,
  SearchTextRequestSchema,
  WorkspaceIdRequestSchema,
} from "@nova/shared";
import {
  FileIndex,
  WorkspaceError,
  createEntry,
  createIgnoreMatcher,
  listDirectory,
  moveEntry,
  readWorkspaceFile,
  searchText,
  watchWorkspace,
  writeWorkspaceFile,
  type IgnoreMatcher,
  type WatchOptions,
  type WorkspaceWatcher,
} from "@nova/workspace";
import { FS_NOTIFY, type FsMethod, type FsMethods, type FsOutcome, type FsSearchMatchesNotify } from "./protocol";

export interface FsHandlersEnv {
  /** Absolute ripgrep path (NOVA_RG_PATH); null = text search answers `unavailable`. */
  rgPath: string | null;
  notify(method: string, params: unknown): void;
  watch?: WatchOptions;
}

interface OpenWorkspace {
  root: string;
  matcher: IgnoreMatcher;
  index: FileIndex;
  watcher: Promise<WorkspaceWatcher | null>;
}

const OpenSchema = z.object({ workspaceId: z.uuid(), root: z.string().refine(isAbsolute, "absolute root") });
const StreamSchema = z.object({ streamId: z.string().min(1).max(100) });
const SearchParamsSchema = SearchTextRequestSchema.extend({ streamId: z.string().min(1).max(100).optional() });

type Handler<M extends FsMethod> = (params: unknown) => Promise<FsOutcome<FsMethods[M]["result"]>>;
export type FsHandlers = { [M in FsMethod]: Handler<M> } & { dispose(): Promise<void> };

class NotOpen extends Error {}

export function createFsHandlers(env: FsHandlersEnv): FsHandlers {
  const workspaces = new Map<string, OpenWorkspace>();
  const searches = new Map<string, AbortController>();

  const get = (workspaceId: string): OpenWorkspace => {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new NotOpen();
    return workspace;
  };

  /** Runs a handler body, turning refusals into typed outcomes (only bugs escape as throws). */
  const guard =
    <S extends z.ZodType, R>(schema: S, body: (params: z.infer<S>) => Promise<R>) =>
    async (raw: unknown): Promise<FsOutcome<R>> => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { ok: false, code: "invalid_argument", message: "invalid parameters" };
      try {
        return { ok: true, value: await body(parsed.data) };
      } catch (error) {
        if (error instanceof NotOpen) return { ok: false, code: "not_open", message: "workspace not open in fs-worker" };
        if (error instanceof WorkspaceError) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    };

  const close = async (workspaceId: string): Promise<void> => {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) return;
    workspaces.delete(workspaceId);
    await (await workspace.watcher)?.close();
  };

  return {
    "workspace.open": guard(OpenSchema, async ({ workspaceId, root }) => {
      const existing = workspaces.get(workspaceId);
      if (existing?.root === root) return null;
      await close(workspaceId);
      const matcher = createIgnoreMatcher(root);
      const index = new FileIndex(root, matcher);
      const watcher = watchWorkspace(
        root,
        matcher,
        (batch) => {
          if (batch.type === "overflow") index.reset();
          else index.apply(batch.changes);
          env.notify(
            FS_NOTIFY.filesEvent,
            batch.type === "overflow" ? { type: "overflow", workspaceId } : { type: "changes", workspaceId, changes: batch.changes },
          );
        },
        env.watch,
      ).catch(() => null); // no live updates, but listing and search still work
      workspaces.set(workspaceId, { root, matcher, index, watcher });
      return null;
    }),

    "workspace.close": guard(WorkspaceIdRequestSchema, async ({ workspaceId }) => {
      await close(workspaceId);
      return null;
    }),

    "files.list": guard(FilesListRequestSchema, async ({ workspaceId, path }) => {
      const { root, matcher } = get(workspaceId);
      return listDirectory(root, matcher, path);
    }),

    "files.read": guard(FilesReadRequestSchema, async ({ workspaceId, path }) =>
      readWorkspaceFile(get(workspaceId).root, path),
    ),

    "files.write": guard(FileWriteRequestSchema, async ({ workspaceId, path, content, expectedHash }) =>
      writeWorkspaceFile(get(workspaceId).root, path, content, expectedHash),
    ),

    "files.create": guard(FilesCreateRequestSchema, async ({ workspaceId, path, kind }) => {
      const { root, matcher } = get(workspaceId);
      return createEntry(root, matcher, path, kind);
    }),

    "files.move": guard(FilesMoveRequestSchema, async ({ workspaceId, from, to }) => {
      const { root, matcher } = get(workspaceId);
      return moveEntry(root, matcher, from, to);
    }),

    "search.text": guard(SearchParamsSchema, async ({ streamId, ...query }) => {
      const { root, matcher } = get(query.workspaceId);
      if (!env.rgPath) throw new WorkspaceError("unavailable", "ripgrep is not available");
      await matcher.load("");
      const controller = new AbortController();
      if (streamId) {
        searches.get(streamId)?.abort();
        searches.set(streamId, controller);
      }
      try {
        return await searchText(root, query, {
          rgPath: env.rgPath,
          signal: controller.signal,
          ...(streamId
            ? {
                onMatches: (matches) =>
                  env.notify(FS_NOTIFY.searchMatches, { streamId, matches } satisfies FsSearchMatchesNotify),
              }
            : {}),
        });
      } finally {
        if (streamId && searches.get(streamId) === controller) searches.delete(streamId);
      }
    }),

    "search.cancel": guard(StreamSchema, async ({ streamId }) => {
      searches.get(streamId)?.abort();
      searches.delete(streamId);
      return null;
    }),

    "search.files": guard(SearchFilesRequestSchema, async ({ workspaceId, query, limit }) =>
      get(workspaceId).index.search(query, limit),
    ),

    async dispose() {
      for (const controller of searches.values()) controller.abort();
      searches.clear();
      await Promise.all([...workspaces.keys()].map(close));
    },
  };
}

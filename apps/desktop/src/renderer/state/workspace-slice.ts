// Atelier explorer state: the lazy file tree of the current workspace and its Git letters.
// The app store owns which workspace is open (`workspace.current`) and binds it here.
// Data mirrored from main through the typed client; paths are workspace-relative (never absolute).
import {
  joinRelativePath,
  parentRelativePath,
  type FileEntry,
  type FilesEvent,
  type GitStatus,
  type GitStatusEntry,
  type NovaApi,
  type RelativePath,
} from "@nova/shared";
import { toUiError, type UiError } from "../lib/errors";

/** The part of the client the atelier uses (tests pass an in-memory fake). */
export type AtelierClient = Pick<NovaApi, "workspace" | "files" | "search" | "git">;

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** One directory level of the lazy tree. */
export interface DirListing {
  status: "loading" | "ready" | "error";
  entries: FileEntry[];
  error: UiError | null;
}

/** Git letter shown in the tree (VISUAL §5.2). */
export type GitLetter = "M" | "A" | "D" | "R" | "?" | "!";

export interface ExplorerData {
  /** Workspace the tree shows (bound from the app store's `workspace.current`). */
  workspaceId: string | null;
  /** Listed directories by relative path ("" = root). Only listed directories are kept fresh. */
  dirs: Record<RelativePath, DirListing>;
  expanded: Record<RelativePath, true>;
  selected: RelativePath | null;
  /** null until loaded; `{ available: false }` when the folder is not a repository. */
  git: GitStatus | null;
  /** Git letter by file path, derived from `git`. */
  gitLetters: Record<RelativePath, GitLetter>;
}

export interface ExplorerActions {
  /**
   * Shows `workspaceId` (null = none): resets the tree, lists the root, reads Git, and switches the
   * editor session. The app store owns opening/closing workspaces; it calls this on change.
   */
  bind(workspaceId: string | null): Promise<void>;
  loadDir(path: RelativePath): Promise<void>;
  toggleDir(path: RelativePath, expanded?: boolean): void;
  select(path: RelativePath | null): void;
  /** Expands every ancestor of `path`, lists them, and selects `path`. */
  reveal(path: RelativePath): Promise<void>;
  refreshGit(): Promise<void>;
  /** Applies a `files.onEvent` batch: re-lists the affected directories that are shown. */
  applyFilesEvent(event: FilesEvent): void;
}

export interface ExplorerSlice {
  explorer: ExplorerData & ExplorerActions;
}

/**
 * Minimal store surface a slice needs. The app store (`AppState` extending the slice) satisfies it,
 * so the lead can spread the slice into `createAppStore` or use `createAtelierStore`.
 */
export interface SliceStore<T> {
  get(): T;
  set(update: (state: T) => Partial<T>): void;
}

const GIT_REFRESH_DELAY_MS = 400;

export function initialExplorerData(): ExplorerData {
  return {
    workspaceId: null,
    dirs: {},
    expanded: {},
    selected: null,
    git: null,
    gitLetters: {},
  };
}

function letterFor(entry: GitStatusEntry): GitLetter | null {
  if (entry.index === "conflicted" || entry.worktree === "conflicted") return "!";
  if (entry.worktree === "untracked") return "?";
  if (entry.worktree === "ignored") return null;
  // The worktree change is what the user sees on disk; the index change only when the tree is clean.
  const kind = entry.worktree !== "unmodified" ? entry.worktree : entry.index;
  switch (kind) {
    case "modified":
    case "type_changed":
      return "M";
    case "added":
    case "copied":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return null;
  }
}

/** Letter per path from a Git status (unavailable Git → no letters, never guessed). */
export function gitLettersOf(status: GitStatus): Record<RelativePath, GitLetter> {
  if (!status.available) return {};
  const letters: Record<RelativePath, GitLetter> = {};
  for (const entry of status.entries) {
    const letter = letterFor(entry);
    if (letter) letters[entry.path] = letter;
  }
  return letters;
}

/** Ancestors of a path, root first ("" included), the path itself excluded. */
export function ancestorsOf(path: RelativePath): RelativePath[] {
  const result: RelativePath[] = [""];
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) result.push(parts.slice(0, index).join("/"));
  return path === "" ? [] : result;
}

/** Hooks the workspace slice calls on the editor slice (kept loose to avoid an import cycle). */
export interface ExplorerHooks {
  onWorkspaceChanged(workspaceId: string | null): Promise<void> | void;
}

export function createExplorerSlice<T extends ExplorerSlice>(
  client: AtelierClient,
  store: SliceStore<T>,
  hooks: ExplorerHooks,
): ExplorerSlice {
  let gitTimer: ReturnType<typeof setTimeout> | null = null;
  let listSeq = 0;
  const listRequests = new Map<RelativePath, number>();

  const data = (): ExplorerData & ExplorerActions => store.get().explorer;
  const patch = (partial: Partial<ExplorerData>): void =>
    store.set((state) => ({ explorer: { ...state.explorer, ...partial } }) as Partial<T>);
  const workspaceId = (): string | null => data().workspaceId;

  const setDir = (path: RelativePath, listing: DirListing): void =>
    store.set((state) => ({ explorer: { ...state.explorer, dirs: { ...state.explorer.dirs, [path]: listing } } }) as Partial<T>);

  async function list(path: RelativePath, quiet: boolean): Promise<void> {
    const id = workspaceId();
    if (!id) return;
    const seq = ++listSeq;
    listRequests.set(path, seq);
    const previous = data().dirs[path];
    // A refresh keeps the rows on screen (no flash); only a first listing shows the loading state.
    if (!quiet || !previous) setDir(path, { status: "loading", entries: previous?.entries ?? [], error: null });
    try {
      const entries = await client.files.list({ workspaceId: id, path });
      if (listRequests.get(path) !== seq || workspaceId() !== id) return;
      setDir(path, { status: "ready", entries, error: null });
    } catch (error) {
      if (listRequests.get(path) !== seq || workspaceId() !== id) return;
      setDir(path, { status: "error", entries: previous?.entries ?? [], error: toUiError(error) });
    }
  }

  function scheduleGit(): void {
    if (gitTimer) clearTimeout(gitTimer);
    gitTimer = setTimeout(() => {
      gitTimer = null;
      void data().refreshGit();
    }, GIT_REFRESH_DELAY_MS);
  }

  const actions: ExplorerActions = {
    async bind(id) {
      if (id === workspaceId()) return;
      listRequests.clear();
      if (gitTimer) clearTimeout(gitTimer);
      gitTimer = null;
      patch({ ...initialExplorerData(), workspaceId: id });
      await Promise.all([hooks.onWorkspaceChanged(id), id ? list("", false) : null, id ? data().refreshGit() : null]);
    },

    loadDir: (path) => list(path, false),

    toggleDir(path, expanded) {
      const isOpen = Boolean(data().expanded[path]);
      const next = expanded ?? !isOpen;
      if (next === isOpen) return;
      const map = { ...data().expanded };
      if (next) map[path] = true;
      else delete map[path];
      patch({ expanded: map });
      if (next && data().dirs[path]?.status !== "ready") void list(path, false);
    },

    select(path) {
      if (data().selected !== path) patch({ selected: path });
    },

    async reveal(path) {
      const ancestors = ancestorsOf(path).filter((dir) => dir !== "");
      if (ancestors.length > 0) {
        const map = { ...data().expanded };
        for (const dir of ancestors) map[dir] = true;
        patch({ expanded: map });
      }
      await Promise.all(
        ["", ...ancestors].filter((dir) => data().dirs[dir]?.status !== "ready").map((dir) => list(dir, false)),
      );
      patch({ selected: path });
    },

    async refreshGit() {
      const id = workspaceId();
      if (!id) return;
      try {
        const git = await client.git.status({ workspaceId: id });
        if (workspaceId() === id) patch({ git, gitLetters: gitLettersOf(git) });
      } catch {
        // Git letters are a hint: when status fails the tree simply shows none.
        if (workspaceId() === id) patch({ git: { available: false }, gitLetters: {} });
      }
    },

    applyFilesEvent(event) {
      if (event.workspaceId !== workspaceId()) return;
      const listed = data().dirs;
      if (event.type === "overflow") {
        for (const dir of Object.keys(listed)) void list(dir, true);
        scheduleGit();
        return;
      }
      const dirs = new Set<RelativePath>();
      for (const change of event.changes) {
        const parent = parentRelativePath(change.path);
        if (listed[parent]) dirs.add(parent);
        // A deleted directory takes its listed descendants with it.
        if (change.kind === "deleted" && change.isDirectory) {
          const prefix = `${change.path}/`;
          const kept = Object.fromEntries(
            Object.entries(data().dirs).filter(([dir]) => dir !== change.path && !dir.startsWith(prefix)),
          );
          patch({ dirs: kept });
        }
      }
      for (const dir of dirs) void list(dir, true);
      scheduleGit();
    },
  };

  return { explorer: { ...initialExplorerData(), ...actions } };
}

/** Relative path of a new entry named `name` inside directory `dir`. */
export function childPath(dir: RelativePath, name: string): RelativePath {
  return joinRelativePath(dir, name);
}

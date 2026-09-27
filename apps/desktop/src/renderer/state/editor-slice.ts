// Atelier editor state: open tabs, save with optimistic concurrency (expectedHash), conflicts with
// the disk, and the per-workspace session (Pr3). Buffer contents are NOT in the reactive state:
// they live in `buffers` (one DocModel per path) so typing never writes to the store.
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  FILE_EDIT_MAX_BYTES,
  parentRelativePath,
  type ContentHash,
  type FileContent,
  type FilesEvent,
  type RelativePath,
} from "@nova/shared";
import { toUiError, type UiError } from "../lib/errors";
import { createExplorerSlice, type AtelierClient, type ExplorerSlice, type SliceStore } from "./workspace-slice";

// ---------------------------------------------------------------------------
// Buffers

/** Immutable view of a buffer at one instant; `token` identifies it for `markSaved`. */
export interface DocSnapshot {
  /** Text with "\n" line breaks. */
  text: string;
  token: unknown;
}

/**
 * A document buffer. The slice creates plain text buffers; the editor surface upgrades them to
 * CodeMirror-backed ones (history, selection, folds) when the tab is shown.
 */
export interface DocModel {
  snapshot(): DocSnapshot;
  /** The disk now holds `saved`; returns true when the buffer changed since (typing during a save). */
  markSaved(saved: DocSnapshot): boolean;
}

/** Plain text buffer, used until a surface shows it. `base` is the disk text the buffer derives from. */
export class TextDoc implements DocModel {
  constructor(
    readonly content: string,
    public base: string,
  ) {}
  snapshot(): DocSnapshot {
    return { text: this.content, token: this.content };
  }
  markSaved(saved: DocSnapshot): boolean {
    this.base = saved.text;
    return this.content !== saved.text;
  }
}

/** CodeMirror normalizes line breaks to "\n"; the tab remembers the file's EOL to write it back. */
export function normalizeEol(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function toDiskEol(text: string, eol: FileContent["eol"]): string {
  return eol === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}

// ---------------------------------------------------------------------------
// State

export type TabKind = "text" | "binary" | "tooLarge";

/** The disk version changed under a buffer with unsaved edits (or the save found another version). */
export interface EditorConflict {
  /** null = the file no longer exists on disk. */
  diskHash: ContentHash | null;
  /** Disk text ("\n" line breaks); null when deleted, binary or unreadable. */
  diskContent: string | null;
}

export interface EditorTab {
  path: RelativePath;
  pinned: boolean;
  /** `idle`: restored from a session, read on first activation. */
  status: "idle" | "loading" | "ready" | "error";
  error: UiError | null;
  kind: TabKind;
  size: number;
  eol: FileContent["eol"];
  /** Disk version the buffer derives from; null = the file does not exist (new or deleted). */
  baseHash: ContentHash | null;
  /** Bumped each time the slice replaces the buffer (load, reload, merge result). */
  version: number;
  dirty: boolean;
  saving: boolean;
  saveError: UiError | null;
  conflict: EditorConflict | null;
  /** The file was deleted on disk while the buffer had no unsaved edits. */
  deletedOnDisk: boolean;
}

/** A position to show once the tab's surface is ready (search result, breadcrumb, quick open `:42`). */
export interface EditorReveal {
  path: RelativePath;
  /** 1-based. */
  line: number;
  /** 0-based UTF-16 offsets within the line, when known. */
  from: number | null;
  to: number | null;
  seq: number;
}

export interface EditorData {
  workspaceId: string | null;
  tabs: EditorTab[];
  activePath: RelativePath | null;
  /** Most recently used first (Ctrl+Tab order). */
  mru: RelativePath[];
  /** Closed tabs, most recent last (Ctrl+Shift+T). */
  closed: RelativePath[];
  /** Bumped when a user action should move focus into the editor (never for agent actions). */
  focusSeq: number;
  reveal: EditorReveal | null;
  /** Non-reactive: buffers by path for the current workspace. Mutated in place, never replaced. */
  buffers: Map<RelativePath, DocModel>;
  /** Non-reactive: scroll positions by path, written by the surface when it hides a tab. */
  scroll: Map<RelativePath, number>;
}

export interface OpenOptions {
  /** User-initiated: focus the editor (default true). Agent-follow opens pass false. */
  focus?: boolean;
  line?: number;
  from?: number;
  to?: number;
}

export interface EditorActions {
  openFile(path: RelativePath, options?: OpenOptions): Promise<void>;
  /** `focus: false` for keyboard moves inside the tab strip, which keep focus on the tabs. */
  activate(path: RelativePath, focus?: boolean): void;
  /** Closes a tab; refuses (returns false) when it has unsaved edits and `force` is not set. */
  closeTab(path: RelativePath, force?: boolean): boolean;
  closeOthers(path: RelativePath): void;
  reopenClosed(): Promise<void>;
  /** Ctrl+Tab: next (1) or previous (-1) tab in most-recently-used order. */
  cycleRecent(direction: 1 | -1): void;
  /** Ctrl+PageDown/PageUp: next or previous tab in strip order. */
  cycleOrder(direction: 1 | -1): void;
  /** Moves a tab within its group (pinned tabs stay before the others). */
  moveTab(path: RelativePath, toIndex: number): void;
  setPinned(path: RelativePath, pinned: boolean): void;
  /** Called by the surface when the dirty state of a buffer flips (never on each keystroke). */
  setDirty(path: RelativePath, dirty: boolean): void;
  save(path: RelativePath): Promise<boolean>;
  saveAll(): Promise<void>;
  /** Conflict: take the disk version (edits are dropped). */
  reloadFromDisk(path: RelativePath): Promise<void>;
  /** Conflict: overwrite the disk with the buffer, knowingly. */
  keepMine(path: RelativePath): Promise<void>;
  /** Conflict resolved in the compare view: `text` becomes the buffer (still unsaved) over the disk version. */
  applyMerged(path: RelativePath, text: string): void;
  /** A tree rename or move: open tabs follow their file. */
  renamePath(from: RelativePath, to: RelativePath): void;
  consumeReveal(seq: number): void;
  /**
   * The surface calls this with the current `focusSeq`; true once per request, so remounting a view
   * (tab switch, reload) never steals focus again.
   */
  claimFocus(focusSeq: number): boolean;
  /** Applies a `files.onEvent` batch to open tabs. */
  applyFilesEvent(event: FilesEvent): void;
  hasUnsaved(): boolean;
  /** Switches the session to another workspace (buffers of the previous one stay in memory). */
  switchWorkspace(workspaceId: string | null): Promise<void>;
}

export interface EditorSlice {
  editor: EditorData & EditorActions;
}

export type AtelierState = ExplorerSlice & EditorSlice;
export type AtelierStore = StoreApi<AtelierState>;

// ---------------------------------------------------------------------------
// Session persistence (Pr3)

export interface EditorSessionSnapshot {
  version: 1;
  tabs: { path: RelativePath; pinned: boolean }[];
  activePath: RelativePath | null;
  /** Scroll offsets in CSS pixels. */
  scroll: Record<RelativePath, number>;
}

/** Where sessions are kept. No IPC exists yet for the `editor_state` table: memory by default. */
export interface EditorSessionStore {
  load(workspaceId: string): Promise<EditorSessionSnapshot | null>;
  save(workspaceId: string, snapshot: EditorSessionSnapshot): Promise<void>;
}

export function memorySessionStore(): EditorSessionStore {
  const sessions = new Map<string, EditorSessionSnapshot>();
  return {
    load: (workspaceId) => Promise.resolve(sessions.get(workspaceId) ?? null),
    save: (workspaceId, snapshot) => {
      sessions.set(workspaceId, snapshot);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------

const CLOSED_LIMIT = 20;

function newTab(path: RelativePath, pinned = false): EditorTab {
  return {
    path,
    pinned,
    status: "idle",
    error: null,
    kind: "text",
    size: 0,
    eol: null,
    baseHash: null,
    version: 0,
    dirty: false,
    saving: false,
    saveError: null,
    conflict: null,
    deletedOnDisk: false,
  };
}

export function initialEditorData(): EditorData {
  return {
    workspaceId: null,
    tabs: [],
    activePath: null,
    mru: [],
    closed: [],
    focusSeq: 0,
    reveal: null,
    buffers: new Map(),
    scroll: new Map(),
  };
}

/** Pinned tabs first, each group keeping its relative order. */
function orderTabs(tabs: EditorTab[]): EditorTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

function kindOf(file: FileContent): TabKind {
  if (file.binary) return "binary";
  if (file.tooLarge || file.content === null) return "tooLarge";
  return "text";
}

function isInside(path: RelativePath, dir: RelativePath): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Session kept in memory while another workspace is shown (buffers included: nothing is lost). */
interface ParkedSession {
  tabs: EditorTab[];
  activePath: RelativePath | null;
  mru: RelativePath[];
  closed: RelativePath[];
  buffers: Map<RelativePath, DocModel>;
  scroll: Map<RelativePath, number>;
}

export function createEditorSlice<T extends EditorSlice>(
  client: AtelierClient,
  store: SliceStore<T>,
  sessions: EditorSessionStore = memorySessionStore(),
): EditorSlice {
  const parked = new Map<string, ParkedSession>();
  /** Latest read per path: an older read that resolves late is dropped. */
  const readSeq = new Map<RelativePath, number>();
  /** Disk checks requested while a save was in flight (run once the save settles). */
  const pendingCheck = new Set<RelativePath>();
  let seq = 0;
  let focusClaimed = 0;

  const data = (): EditorData & EditorActions => store.get().editor;
  const patch = (partial: Partial<EditorData>): void =>
    store.set((state) => ({ editor: { ...state.editor, ...partial } }) as Partial<T>);
  const tabOf = (path: RelativePath): EditorTab | undefined => data().tabs.find((tab) => tab.path === path);
  const patchTab = (path: RelativePath, partial: Partial<EditorTab>): void =>
    store.set(
      (state) =>
        ({
          editor: {
            ...state.editor,
            tabs: state.editor.tabs.map((tab) => (tab.path === path ? { ...tab, ...partial } : tab)),
          },
        }) as Partial<T>,
    );
  const touchMru = (path: RelativePath): RelativePath[] => [path, ...data().mru.filter((item) => item !== path)];

  async function readFile(path: RelativePath): Promise<{ file: FileContent } | { error: unknown } | null> {
    const workspaceId = data().workspaceId;
    if (!workspaceId) return null;
    const mine = ++seq;
    readSeq.set(path, mine);
    try {
      const file = await client.files.read({ workspaceId, path });
      return readSeq.get(path) === mine && data().workspaceId === workspaceId ? { file } : null;
    } catch (error) {
      return readSeq.get(path) === mine && data().workspaceId === workspaceId ? { error } : null;
    }
  }

  /** Installs the disk version as the buffer (fresh history) and the tab's base. */
  function installDisk(path: RelativePath, file: FileContent): void {
    const kind = kindOf(file);
    const content = kind === "text" && file.content !== null ? normalizeEol(file.content) : "";
    data().buffers.set(path, new TextDoc(content, content));
    const tab = tabOf(path);
    patchTab(path, {
      status: "ready",
      error: null,
      kind,
      size: file.size,
      eol: file.eol,
      baseHash: file.hash,
      version: (tab?.version ?? 0) + 1,
      dirty: false,
      saveError: null,
      conflict: null,
      deletedOnDisk: false,
    });
  }

  async function load(path: RelativePath): Promise<void> {
    patchTab(path, { status: "loading", error: null });
    const result = await readFile(path);
    if (!result || !tabOf(path)) return;
    if ("error" in result) patchTab(path, { status: "error", error: toUiError(result.error) });
    else installDisk(path, result.file);
  }

  /** Compares the disk with an open tab after an external change (C5: never overwrite silently). */
  async function checkDisk(path: RelativePath, deleted: boolean): Promise<void> {
    const tab = tabOf(path);
    if (!tab || tab.status !== "ready") return;
    if (tab.saving) {
      pendingCheck.add(path);
      return;
    }
    if (deleted) {
      if (tab.dirty) patchTab(path, { conflict: { diskHash: null, diskContent: null } });
      else patchTab(path, { deletedOnDisk: true, baseHash: null });
      return;
    }
    const result = await readFile(path);
    const current = tabOf(path);
    if (!result || !current) return;
    if ("error" in result) return; // Unreadable now (mid-write, permissions): the next event re-checks.
    const { file } = result;
    // Our own save, or a touch that did not change the bytes.
    if (file.hash === current.baseHash && !current.deletedOnDisk) return;
    if (current.saving) {
      pendingCheck.add(path);
      return;
    }
    if (!current.dirty) {
      installDisk(path, file);
      return;
    }
    const diskContent = kindOf(file) === "text" && file.content !== null ? normalizeEol(file.content) : null;
    patchTab(path, { conflict: { diskHash: file.hash, diskContent }, deletedOnDisk: false });
  }

  async function write(path: RelativePath, expectedHash: ContentHash | null): Promise<boolean> {
    const tab = tabOf(path);
    const buffer = data().buffers.get(path);
    const workspaceId = data().workspaceId;
    if (!tab || !buffer || !workspaceId || tab.kind !== "text" || tab.status !== "ready" || tab.saving) return false;
    const snapshot = buffer.snapshot();
    const content = toDiskEol(snapshot.text, tab.eol);
    if (content.length > FILE_EDIT_MAX_BYTES) {
      patchTab(path, { saveError: { code: "invalid_request", providerError: null } });
      return false;
    }
    patchTab(path, { saving: true, saveError: null });
    try {
      const result = await client.files.write({ workspaceId, path, content, expectedHash });
      if (!tabOf(path)) return result.status === "written";
      if (result.status === "written") {
        const stillDirty = (data().buffers.get(path) ?? buffer).markSaved(snapshot);
        patchTab(path, {
          saving: false,
          baseHash: result.hash,
          size: result.size,
          dirty: stillDirty,
          conflict: null,
          deletedOnDisk: false,
        });
        return true;
      }
      // Another version is on disk: never overwrite, show the conflict with the disk text.
      patchTab(path, { saving: false });
      const disk = result.currentHash === null ? null : await readFile(path);
      const file = disk && "file" in disk ? disk.file : null;
      patchTab(path, {
        conflict: {
          diskHash: file?.hash ?? result.currentHash,
          diskContent: file && kindOf(file) === "text" && file.content !== null ? normalizeEol(file.content) : null,
        },
      });
      return false;
    } catch (error) {
      if (tabOf(path)) patchTab(path, { saving: false, saveError: toUiError(error) });
      return false;
    } finally {
      if (pendingCheck.delete(path)) void checkDisk(path, false);
    }
  }

  const actions: EditorActions = {
    async openFile(path, options = {}) {
      const state = data();
      const focus = options.focus ?? true;
      const reveal: EditorReveal | null =
        options.line === undefined
          ? null
          : { path, line: options.line, from: options.from ?? null, to: options.to ?? null, seq: ++seq };
      const existing = tabOf(path);
      patch({
        tabs: existing ? state.tabs : [...state.tabs, newTab(path)],
        activePath: path,
        mru: touchMru(path),
        focusSeq: focus ? state.focusSeq + 1 : state.focusSeq,
        reveal: reveal ?? state.reveal,
      });
      const tab = tabOf(path);
      if (tab && (tab.status === "idle" || tab.status === "error")) await load(path);
    },

    activate(path, focus = true) {
      const tab = tabOf(path);
      if (!tab) return;
      patch({ activePath: path, mru: touchMru(path), focusSeq: focus ? data().focusSeq + 1 : data().focusSeq });
      if (tab.status === "idle") void load(path);
    },

    closeTab(path, force = false) {
      const state = data();
      const index = state.tabs.findIndex((tab) => tab.path === path);
      const tab = state.tabs[index];
      if (!tab) return true;
      if (tab.dirty && !force) return false;
      const tabs = state.tabs.filter((item) => item.path !== path);
      const mru = state.mru.filter((item) => item !== path);
      // Focus goes to the neighbor (next, else previous), like the conversation list (POWER_UX 6.4).
      const neighbor = tabs[index]?.path ?? tabs[index - 1]?.path ?? null;
      state.buffers.delete(path);
      readSeq.delete(path);
      patch({
        tabs,
        mru,
        activePath: state.activePath === path ? neighbor : state.activePath,
        closed: [...state.closed.filter((item) => item !== path), path].slice(-CLOSED_LIMIT),
      });
      return true;
    },

    closeOthers(path) {
      for (const tab of data().tabs) {
        if (tab.path !== path && !tab.pinned && !tab.dirty) data().closeTab(tab.path);
      }
    },

    async reopenClosed() {
      const closed = [...data().closed];
      const path = closed.pop();
      if (path === undefined) return;
      patch({ closed });
      await data().openFile(path);
    },

    cycleRecent(direction) {
      const { mru, activePath, tabs } = data();
      const order = mru.filter((path) => tabs.some((tab) => tab.path === path));
      if (order.length < 2 || activePath === null) return;
      const index = order.indexOf(activePath);
      const next = order[(index + direction + order.length) % order.length];
      // Cycling does not reorder the MRU list until the user settles (like Alt+Tab).
      if (next !== undefined) {
        patch({ activePath: next, focusSeq: data().focusSeq + 1 });
        if (tabOf(next)?.status === "idle") void load(next);
      }
    },

    cycleOrder(direction) {
      const { tabs, activePath } = data();
      if (tabs.length < 2 || activePath === null) return;
      const index = tabs.findIndex((tab) => tab.path === activePath);
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      if (next) data().activate(next.path);
    },

    moveTab(path, toIndex) {
      const tabs = [...data().tabs];
      const from = tabs.findIndex((tab) => tab.path === path);
      const tab = tabs[from];
      if (!tab) return;
      tabs.splice(from, 1);
      // A tab never leaves its group: clamp into the pinned or unpinned range.
      const pinnedCount = tabs.filter((item) => item.pinned).length;
      const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, tabs.length];
      tabs.splice(Math.min(Math.max(toIndex, min), max), 0, tab);
      patch({ tabs });
    },

    setPinned(path, pinned) {
      const tabs = data().tabs.map((tab) => (tab.path === path ? { ...tab, pinned } : tab));
      patch({ tabs: orderTabs(tabs) });
    },

    setDirty(path, dirty) {
      const tab = tabOf(path);
      if (tab && tab.dirty !== dirty) patchTab(path, { dirty });
    },

    save: (path) => {
      const tab = tabOf(path);
      // A pending conflict must be resolved explicitly: Ctrl+S never picks a side.
      if (!tab || tab.conflict) return Promise.resolve(false);
      return write(path, tab.baseHash);
    },

    async saveAll() {
      await Promise.all(
        data()
          .tabs.filter((tab) => tab.dirty && !tab.conflict)
          .map((tab) => data().save(tab.path)),
      );
    },

    async reloadFromDisk(path) {
      const tab = tabOf(path);
      if (!tab) return;
      const result = await readFile(path);
      if (!result || !tabOf(path)) return;
      if ("error" in result) {
        patchTab(path, { saveError: toUiError(result.error) });
        return;
      }
      installDisk(path, result.file);
    },

    async keepMine(path) {
      const tab = tabOf(path);
      if (!tab) return;
      const expected = tab.conflict ? tab.conflict.diskHash : tab.baseHash;
      patchTab(path, { conflict: null, baseHash: expected });
      await write(path, expected);
    },

    applyMerged(path, text) {
      const tab = tabOf(path);
      if (!tab?.conflict) return;
      const { diskHash, diskContent } = tab.conflict;
      data().buffers.set(path, new TextDoc(text, diskContent ?? ""));
      patchTab(path, {
        conflict: null,
        baseHash: diskHash,
        version: tab.version + 1,
        dirty: text !== (diskContent ?? "") || diskHash === null,
        deletedOnDisk: diskHash === null,
      });
    },

    renamePath(from, to) {
      const state = data();
      const rename = (path: RelativePath): RelativePath => (isInside(path, from) ? to + path.slice(from.length) : path);
      if (!state.tabs.some((tab) => isInside(tab.path, from))) return;
      for (const [path, buffer] of [...state.buffers]) {
        if (!isInside(path, from)) continue;
        state.buffers.delete(path);
        state.buffers.set(rename(path), buffer);
      }
      patch({
        tabs: state.tabs.map((tab) => (isInside(tab.path, from) ? { ...tab, path: rename(tab.path) } : tab)),
        activePath: state.activePath === null ? null : rename(state.activePath),
        mru: state.mru.map(rename),
      });
    },

    claimFocus(focusSeq) {
      if (focusSeq <= focusClaimed) return false;
      focusClaimed = focusSeq;
      return true;
    },

    consumeReveal(revealSeq) {
      if (data().reveal?.seq === revealSeq) patch({ reveal: null });
    },

    applyFilesEvent(event) {
      if (event.workspaceId !== data().workspaceId) return;
      const tabs = data().tabs.filter((tab) => tab.status === "ready");
      if (event.type === "overflow") {
        for (const tab of tabs) void checkDisk(tab.path, false);
        return;
      }
      for (const change of event.changes) {
        for (const tab of tabs) {
          const affected = change.isDirectory ? isInside(tab.path, change.path) : tab.path === change.path;
          if (affected) void checkDisk(tab.path, change.kind === "deleted");
        }
      }
    },

    hasUnsaved: () => data().tabs.some((tab) => tab.dirty),

    async switchWorkspace(workspaceId) {
      const state = data();
      if (state.workspaceId === workspaceId) return;
      if (state.workspaceId) {
        await sessions.save(state.workspaceId, editorSessionOf(state)).catch(() => undefined);
        parked.set(state.workspaceId, {
          tabs: state.tabs,
          activePath: state.activePath,
          mru: state.mru,
          closed: state.closed,
          buffers: state.buffers,
          scroll: state.scroll,
        });
      }
      readSeq.clear();
      pendingCheck.clear();
      const back = workspaceId ? parked.get(workspaceId) : undefined;
      if (back && workspaceId) {
        parked.delete(workspaceId);
        patch({ ...back, workspaceId, reveal: null });
        return;
      }
      patch({ ...initialEditorData(), workspaceId, focusSeq: state.focusSeq });
      if (!workspaceId) return;
      const saved = await sessions.load(workspaceId).catch(() => null);
      if (!saved || data().workspaceId !== workspaceId) return;
      const tabs = orderTabs(saved.tabs.map((tab) => newTab(tab.path, tab.pinned)));
      const activePath = saved.activePath && tabs.some((tab) => tab.path === saved.activePath) ? saved.activePath : null;
      patch({
        tabs,
        activePath,
        mru: activePath ? [activePath] : [],
        scroll: new Map(Object.entries(saved.scroll)),
      });
      if (activePath) await load(activePath);
    },
  };

  return { editor: { ...initialEditorData(), ...actions } };
}

/** Session snapshot of the current workspace, for the persistence subscription. */
export function editorSessionOf(state: EditorData): EditorSessionSnapshot {
  return {
    version: 1,
    tabs: state.tabs.map((tab) => ({ path: tab.path, pinned: tab.pinned })),
    activePath: state.activePath,
    scroll: Object.fromEntries(state.scroll),
  };
}

// ---------------------------------------------------------------------------
// Standalone atelier store (the lead may instead spread both slices into the app store)

export interface AtelierStoreOptions {
  sessions?: EditorSessionStore;
}

export function createAtelierStore(client: AtelierClient, options: AtelierStoreOptions = {}): AtelierStore {
  return createStore<AtelierState>()((set, get) => {
    const store: SliceStore<AtelierState> = { get, set: (update) => set(update) };
    return {
      ...createExplorerSlice(client, store, {
        onWorkspaceChanged: (workspaceId) => get().editor.switchWorkspace(workspaceId),
      }),
      ...createEditorSlice(client, store, options.sessions),
    };
  });
}

const SESSION_SAVE_DELAY_MS = 500;

/**
 * Wires the atelier to main: file events feed the tree and the open tabs, and the editor session
 * is saved (debounced) when tabs change. Returns the unsubscribe function.
 */
export function startAtelierSync(
  store: StoreApi<AtelierState>,
  client: AtelierClient,
  sessions?: EditorSessionStore,
): () => void {
  const unsubscribeFiles = client.files.onEvent((event) => {
    const state = store.getState();
    state.explorer.applyFilesEvent(event);
    state.editor.applyFilesEvent(event);
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribeStore = sessions
    ? store.subscribe((state, previous) => {
        const { editor } = state;
        if (editor.tabs === previous.editor.tabs && editor.activePath === previous.editor.activePath) return;
        const workspaceId = editor.workspaceId;
        if (!workspaceId || workspaceId !== previous.editor.workspaceId) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          const now = store.getState().editor;
          if (now.workspaceId === workspaceId) void sessions.save(workspaceId, editorSessionOf(now)).catch(() => undefined);
        }, SESSION_SAVE_DELAY_MS);
      })
    : () => undefined;
  return () => {
    unsubscribeFiles();
    unsubscribeStore();
    if (timer) clearTimeout(timer);
  };
}

/** Directory containing a path ("" for top-level files); re-exported for components. */
export const dirnameOf = parentRelativePath;

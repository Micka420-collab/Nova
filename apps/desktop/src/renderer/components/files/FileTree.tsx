// Lazy file tree of the current workspace (FEATURES E1, VISUAL §5.2): WAI-ARIA tree with roving
// focus, Git letters, Nomi dots, inline create/rename, trash with confirmation, context menu.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Button, Dialog, Skeleton, VisuallyHidden } from "@nova/ui";
import { parentRelativePath, type RelativePath } from "@nova/shared";
import { describeUiError, toUiError } from "../../lib/errors";
import { childPath } from "../../state/workspace-slice";
import { useAtelier, useAtelierClient, useAtelierStore } from "../editor/atelier-context";
import { ChevronIcon, FileIcon, FolderIcon, LockIcon } from "./file-icons";
import { flattenVisibleRows, nameError, nextFocus, typeaheadMatch, type TreeKey, type TreeRow } from "./tree-model";
import { GIT_STATUS_COPY, treeCopy } from "./tree-copy";
// Side-effect import: the tree's stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./files.css";

export interface FileTreeProps {
  /** Paths the current mission touched (real mission events): a 6 px Nomi dot. */
  agentTouchedPaths?: ReadonlySet<string>;
  /** Replaces the default open action (`editor.openFile`). */
  onOpenFile?: (path: RelativePath) => void;
  label?: string;
}

type Edit =
  | { mode: "file" | "directory"; dir: RelativePath }
  | { mode: "rename"; path: RelativePath; name: string };

interface Menu {
  /** null = the workspace root (right click on the empty area). */
  row: TreeRow | null;
  x: number;
  y: number;
}

const NAV_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "Home", "End", "ArrowRight", "ArrowLeft"]);
const TYPEAHEAD_RESET_MS = 600;

function depthStyle(depth: number): CSSProperties {
  return { ["--nova-tree-depth" as string]: depth - 1 } as CSSProperties;
}

function isOpenable(row: TreeRow): boolean {
  return row.entry !== null && !row.entry.outsideWorkspace;
}

function InlineName({
  label,
  initial,
  depth,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  depth: number;
  onSubmit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = `nova-tree-name-error-${depth}`;

  const submit = async (): Promise<void> => {
    const invalid = nameError(value, { empty: treeCopy.nameEmpty, invalid: treeCopy.nameInvalid });
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    const failure = await onSubmit(value.trim());
    setBusy(false);
    if (failure) setError(failure);
  };

  return (
    <li role="none" className="nova-tree__edit" style={depthStyle(depth)}>
      <input
        className="nova-tree__input"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={busy}
        autoFocus
        onFocus={(event) => {
          // Select the stem so typing replaces the name but keeps the extension.
          const dot = event.currentTarget.value.lastIndexOf(".");
          event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length);
        }}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy && !error) onCancel();
        }}
      />
      {error ? (
        <p id={errorId} className="nova-tree__input-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function ContextMenu({
  menu,
  onClose,
  items,
}: {
  menu: Menu;
  onClose: (restoreFocus: boolean) => void;
  items: { label: string; run: () => void }[];
}) {
  const ref = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, []);

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [onClose]);

  const move = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    let target: HTMLElement | undefined;
    if (event.key === "ArrowDown") target = buttons[(index + 1) % buttons.length];
    else if (event.key === "ArrowUp") target = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === "Home") target = buttons[0];
    else if (event.key === "End") target = buttons[buttons.length - 1];
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    } else if (event.key === "Tab") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <ul
      ref={ref}
      role="menu"
      aria-label={menu.row ? treeCopy.menuLabel(menu.row.name) : treeCopy.rootMenuLabel}
      className="nova-tree__menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={move}
    >
      {items.map((item) => (
        <li key={item.label} role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="nova-tree__menu-item"
            onClick={() => {
              onClose(false);
              item.run();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function FileTree({ agentTouchedPaths, onOpenFile, label = treeCopy.label }: FileTreeProps) {
  const store = useAtelierStore();
  const client = useAtelierClient();
  const workspaceId = useAtelier((state) => state.explorer.workspaceId);
  const dirs = useAtelier((state) => state.explorer.dirs);
  const expanded = useAtelier((state) => state.explorer.expanded);
  const selected = useAtelier((state) => state.explorer.selected);
  const gitLetters = useAtelier((state) => state.explorer.gitLetters);

  const rows = useMemo(() => flattenVisibleRows(dirs, expanded), [dirs, expanded]);
  const [focused, setFocused] = useState<RelativePath | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [trashTarget, setTrashTarget] = useState<TreeRow | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const rowRefs = useRef(new Map<RelativePath, HTMLLIElement>());
  const typeahead = useRef({ buffer: "", timer: null as ReturnType<typeof setTimeout> | null });

  // Roving tabindex: the focused row if still shown, else the selected one, else the first row.
  const focusable = rows.filter((row) => row.kind !== "loading");
  const tabStop =
    focusable.find((row) => row.path === focused)?.path ??
    focusable.find((row) => row.path === selected)?.path ??
    focusable[0]?.path ??
    null;

  useEffect(() => {
    if (focusRequest === 0 || tabStop === null) return;
    rowRefs.current.get(tabStop)?.focus();
  }, [focusRequest, tabStop]);

  useEffect(() => {
    const state = typeahead.current;
    return () => {
      if (state.timer) clearTimeout(state.timer);
    };
  }, []);

  if (!workspaceId) {
    return <p className="nova-tree__empty">{treeCopy.noWorkspace}</p>;
  }

  const explorer = () => store.getState().explorer;
  const focusRow = (path: RelativePath): void => {
    setFocused(path);
    setFocusRequest((value) => value + 1);
  };

  const open = (row: TreeRow): void => {
    if (!isOpenable(row) || row.kind === "directory") return;
    explorer().select(row.path);
    if (onOpenFile) onOpenFile(row.path);
    else void store.getState().editor.openFile(row.path);
  };

  const activate = (row: TreeRow): void => {
    if (row.kind === "error") {
      void explorer().loadDir(row.parent);
      return;
    }
    if (row.kind === "directory") {
      explorer().select(row.path);
      explorer().toggleDir(row.path);
    } else open(row);
  };

  const targetDir = (row: TreeRow | null): RelativePath =>
    row === null ? "" : row.kind === "directory" ? row.path : row.parent;

  const startCreate = (row: TreeRow | null, mode: "file" | "directory"): void => {
    const dir = targetDir(row);
    if (dir !== "") explorer().toggleDir(dir, true);
    setEdit({ mode, dir });
  };

  const startRename = (row: TreeRow): void => {
    if (row.entry && !row.entry.outsideWorkspace) setEdit({ mode: "rename", path: row.path, name: row.name });
  };

  const askTrash = (row: TreeRow): void => {
    if (!row.entry) return;
    setTrashError(null);
    setTrashTarget(row);
  };

  const copyPath = (row: TreeRow): void => {
    navigator.clipboard
      .writeText(row.path)
      .then(() => setStatus(treeCopy.pathCopied))
      .catch(() => setStatus(treeCopy.copyFailed));
  };

  const failure = (error: unknown): string => describeUiError(toUiError(error)).title;

  const submitCreate = async (dir: RelativePath, kind: "file" | "directory", name: string): Promise<string | null> => {
    const path = childPath(dir, name);
    try {
      await client.files.create({ workspaceId, path, kind });
    } catch (error) {
      return failure(error);
    }
    setEdit(null);
    await explorer().loadDir(dir);
    explorer().select(path);
    focusRow(path);
    if (kind === "file") {
      if (onOpenFile) onOpenFile(path);
      else void store.getState().editor.openFile(path);
    }
    return null;
  };

  const submitRename = async (from: RelativePath, name: string): Promise<string | null> => {
    const parent = parentRelativePath(from);
    const to = childPath(parent, name);
    if (to === from) {
      setEdit(null);
      focusRow(from);
      return null;
    }
    try {
      await client.files.move({ workspaceId, from, to });
    } catch (error) {
      return failure(error);
    }
    setEdit(null);
    store.getState().editor.renamePath(from, to);
    await explorer().loadDir(parent);
    explorer().select(to);
    focusRow(to);
    return null;
  };

  const confirmTrash = async (): Promise<void> => {
    const row = trashTarget;
    if (!row) return;
    try {
      await client.files.trash({ workspaceId, path: row.path });
    } catch (error) {
      setTrashError(failure(error));
      return;
    }
    setTrashTarget(null);
    if (explorer().selected === row.path) explorer().select(null);
    await explorer().loadDir(row.parent);
  };

  const openMenu = (row: TreeRow | null, x: number, y: number): void => setMenu({ row, x, y });

  const menuItems = (row: TreeRow | null): { label: string; run: () => void }[] => {
    const items: { label: string; run: () => void }[] = [
      { label: treeCopy.newFile, run: () => startCreate(row, "file") },
      { label: treeCopy.newFolder, run: () => startCreate(row, "directory") },
    ];
    if (row?.entry && !row.entry.outsideWorkspace) {
      items.push(
        { label: treeCopy.rename, run: () => startRename(row) },
        { label: treeCopy.trash, run: () => askTrash(row) },
      );
    }
    if (row?.entry) items.push({ label: treeCopy.copyPath, run: () => copyPath(row) });
    return items;
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, row: TreeRow): void => {
    if (event.target !== event.currentTarget) return;
    const { key } = event;
    if (NAV_KEYS.has(key)) {
      event.preventDefault();
      const move = nextFocus(rows, row.path, key as TreeKey);
      if (move?.type === "focus") focusRow(move.path);
      else if (move?.type === "expand") explorer().toggleDir(move.path, true);
      else if (move?.type === "collapse") explorer().toggleDir(move.path, false);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      activate(row);
    } else if (key === "F2") {
      event.preventDefault();
      startRename(row);
    } else if (key === "Delete") {
      event.preventDefault();
      if (row.entry && !row.entry.outsideWorkspace) askTrash(row);
    } else if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(row, rect.left + 24, rect.bottom);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && key !== " ") {
      const state = typeahead.current;
      state.buffer += key;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.buffer = "";
        state.timer = null;
      }, TYPEAHEAD_RESET_MS);
      const match = typeaheadMatch(rows, row.path, state.buffer);
      if (match) focusRow(match);
    }
  };

  const accessibleName = (row: TreeRow): string => {
    const parts = [row.name];
    const letter = gitLetters[row.path];
    if (letter) parts.push(GIT_STATUS_COPY[letter]);
    if (row.entry?.ignored) parts.push(treeCopy.ignored);
    if (agentTouchedPaths?.has(row.path)) parts.push(treeCopy.agentTouched);
    return parts.join(", ");
  };

  const editRow = (dir: RelativePath, depth: number) =>
    edit && edit.mode !== "rename" && edit.dir === dir ? (
      <InlineName
        key={`${dir}#new`}
        label={edit.mode === "file" ? treeCopy.newFileInput : treeCopy.newFolderInput}
        initial=""
        depth={depth}
        onSubmit={(name) => submitCreate(dir, edit.mode, name)}
        onCancel={() => setEdit(null)}
      />
    ) : null;

  const rootListing = dirs[""];
  const rootEmpty = rootListing?.status === "ready" && rootListing.entries.length === 0;

  const renderRow = (row: TreeRow) => {
    if (row.kind === "loading") {
      return (
        <li key={row.path} role="none" className="nova-tree__placeholder" style={depthStyle(row.depth)}>
          <Skeleton width="60%" height={10} />
          <VisuallyHidden>{treeCopy.loading}</VisuallyHidden>
        </li>
      );
    }
    const isTabStop = row.path === tabStop;
    const ref = (node: HTMLLIElement | null): void => {
      if (node) rowRefs.current.set(row.path, node);
      else rowRefs.current.delete(row.path);
    };
    const onKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>): void => onRowKeyDown(event, row);

    if (row.kind === "error") {
      return (
        <li
          key={row.path}
          ref={ref}
          role="treeitem"
          tabIndex={isTabStop ? 0 : -1}
          aria-level={row.depth}
          aria-label={treeCopy.unreadable}
          className="nova-tree__row nova-tree__row--error"
          style={depthStyle(row.depth)}
          onFocus={() => setFocused(row.path)}
          onKeyDown={onKeyDown}
        >
          <span className="nova-tree__name">{treeCopy.unreadable}</span>
          <Button size="sm" variant="ghost" tabIndex={-1} onClick={() => void explorer().loadDir(row.parent)}>
            {treeCopy.retry}
          </Button>
        </li>
      );
    }

    if (edit?.mode === "rename" && edit.path === row.path) {
      return (
        <InlineName
          key={row.path}
          label={treeCopy.renameInput(row.name)}
          initial={edit.name}
          depth={row.depth}
          onSubmit={(name) => submitRename(row.path, name)}
          onCancel={() => {
            setEdit(null);
            focusRow(row.path);
          }}
        />
      );
    }

    const entry = row.entry;
    const outside = entry?.outsideWorkspace ?? false;
    const letter = gitLetters[row.path];
    const isDir = row.kind === "directory";
    const className = [
      "nova-tree__row",
      selected === row.path && "nova-tree__row--selected",
      entry?.ignored && "nova-tree__row--ignored",
      outside && "nova-tree__row--outside",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <li
        key={row.path}
        ref={ref}
        role="treeitem"
        tabIndex={isTabStop ? 0 : -1}
        aria-level={row.depth}
        style={depthStyle(row.depth)}
        onFocus={() => setFocused(row.path)}
        onKeyDown={onKeyDown}
        className={className}
        aria-label={accessibleName(row)}
        aria-selected={selected === row.path}
        aria-expanded={isDir ? row.isExpanded : undefined}
        aria-disabled={outside || undefined}
        title={outside ? treeCopy.outside : undefined}
        onClick={() => {
          setFocused(row.path);
          activate(row);
        }}
        onContextMenu={(event: ReactMouseEvent<HTMLLIElement>) => {
          event.preventDefault();
          event.stopPropagation();
          setFocused(row.path);
          openMenu(row, event.clientX, event.clientY);
        }}
      >
        <span className="nova-tree__chevron" aria-hidden data-open={row.isExpanded || undefined}>
          {isDir ? <ChevronIcon /> : null}
        </span>
        {outside ? <LockIcon /> : isDir ? <FolderIcon open={row.isExpanded} /> : <FileIcon name={row.name} />}
        <span className="nova-tree__name">{row.name}</span>
        <span className="nova-tree__meta" aria-hidden>
          {agentTouchedPaths?.has(row.path) ? <span className="nova-tree__nomi-dot" /> : null}
          {letter ? (
            <span className="nova-tree__git" data-letter={letter}>
              {letter}
            </span>
          ) : null}
        </span>
      </li>
    );
  };

  const items = [];
  const rootEdit = editRow("", 1);
  if (rootEdit) items.push(rootEdit);
  for (const row of rows) {
    items.push(renderRow(row));
    if (row.kind === "directory" && row.isExpanded) {
      const create = editRow(row.path, row.depth + 1);
      if (create) items.push(create);
    }
  }

  return (
    <div
      className="nova-tree"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(null, event.clientX, event.clientY);
      }}
    >
      <ul role="tree" aria-label={label} className="nova-tree__list">
        {items}
      </ul>
      {rootEmpty && !edit ? <p className="nova-tree__empty">{treeCopy.empty}</p> : null}
      {menu ? (
        <ContextMenu
          menu={menu}
          items={menuItems(menu.row)}
          onClose={(restoreFocus) => {
            const row = menu.row;
            setMenu(null);
            if (restoreFocus && row) focusRow(row.path);
          }}
        />
      ) : null}
      <Dialog
        open={trashTarget !== null}
        onClose={() => setTrashTarget(null)}
        title={trashTarget ? treeCopy.trashTitle(trashTarget.name) : ""}
        description={treeCopy.trashBody}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTrashTarget(null)}>
              {treeCopy.cancel}
            </Button>
            <Button variant="danger" onClick={() => void confirmTrash()}>
              {treeCopy.trashConfirm}
            </Button>
          </>
        }
      >
        {trashError ? (
          <p className="nova-tree__input-error" role="alert">
            {trashError}
          </p>
        ) : null}
      </Dialog>
      <output className="nv-visually-hidden">{status}</output>
    </div>
  );
}

// Editor group of the workbench (VISUAL §4.2): tabs, breadcrumbs + file info, conflict banners,
// the CodeMirror surface, and the empty / loading / error / binary / too-large states (UX §8.2).
import { useCallback, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Button, Callout, Dialog, EmptyState, Kbd, Skeleton, VisuallyHidden } from "@nova/ui";
import { describeUiError } from "../../lib/errors";
import { ChevronIcon } from "../files/file-icons";
import { SearchIcon } from "../icons";
import { MOD_KEY } from "../../lib/platform";
import type { EditorTab } from "../../state/editor-slice";
import { useAtelier, useAtelierStore } from "./atelier-context";
import { CompareView } from "./CompareView";
import { LARGE_FILE_BYTES, type CursorInfo } from "./codemirror/setup";
import { languageName } from "./codemirror/languages";
import { editorCopy } from "./copy";
import { EditorSurface } from "./EditorSurface";
import { basenameOf, EditorTabStrip } from "./EditorTabStrip";
import { resolveAtelierShortcut, type AtelierCommand } from "./shortcuts";
// oxlint-disable-next-line import/no-unassigned-import -- side-effect stylesheet (extracted to a file by Vite)
import "./editor.css";

const EMPTY_SET: ReadonlySet<string> = new Set();
const RECENT_SHOWN = 5;

export interface EditorWorkbenchProps {
  /** Files the running mission is writing: their tab shows the orbit (real events only). */
  agentWritingPaths?: ReadonlySet<string>;
  /** Opens quick open (Ctrl/Cmd+P); the empty state offers it when provided. */
  onQuickOpen?: () => void;
  /** Opens the project search panel (Ctrl/Cmd+Shift+F). */
  onProjectSearch?: () => void;
}

/** Cursor position shared with the info bar without re-rendering the workbench on each keystroke. */
function createCursorBus() {
  let value: CursorInfo | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: CursorInfo | null) {
      if (value && next && value.line === next.line && value.column === next.column && value.selections === next.selections) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
type CursorBus = ReturnType<typeof createCursorBus>;

function CursorLabel({ bus }: { bus: CursorBus }) {
  const cursor = useSyncExternalStore(bus.subscribe, bus.get);
  if (!cursor) return null;
  return (
    <span className="nv-fileinfo__item nv-tabular">
      {editorCopy.lineColumn(cursor.line, cursor.column)}
      {cursor.selections > 1 ? ` · ${editorCopy.selections(cursor.selections)}` : ""}
    </span>
  );
}

function Breadcrumbs({ path }: { path: string }) {
  const store = useAtelierStore();
  const parts = path.split("/");
  return (
    <nav className="nv-breadcrumbs" aria-label={editorCopy.breadcrumbsLabel}>
      <ol>
        {parts.map((part, index) => {
          const prefix = parts.slice(0, index + 1).join("/");
          const last = index === parts.length - 1;
          return (
            <li key={prefix}>
              {index > 0 ? (
                <span className="nv-breadcrumbs__sep" aria-hidden>
                  <ChevronIcon />
                </span>
              ) : null}
              {last ? (
                <span aria-current="page">{part}</span>
              ) : (
                <button type="button" className="nv-breadcrumbs__link" onClick={() => void store.getState().explorer.reveal(prefix)}>
                  {part}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function FileInfo({ tab, bus }: { tab: EditorTab; bus: CursorBus }) {
  const language = languageName(tab.path) ?? editorCopy.plainText;
  return (
    <p className="nv-fileinfo">
      {tab.kind === "text" && tab.status === "ready" ? <CursorLabel bus={bus} /> : null}
      {tab.kind === "text" ? <span className="nv-fileinfo__item">{editorCopy.encoding}</span> : null}
      {tab.kind === "text" && tab.status === "ready" ? (
        <span className="nv-fileinfo__item">{editorCopy.eol[tab.eol ?? "lf"]}</span>
      ) : null}
      <span className="nv-fileinfo__item">{language}</span>
      {tab.status === "ready" ? <span className="nv-fileinfo__item nv-tabular">{editorCopy.size(tab.size)}</span> : null}
    </p>
  );
}

function Banners({ tab, onCompare }: { tab: EditorTab; onCompare(): void }) {
  const store = useAtelierStore();
  const editor = () => store.getState().editor;
  if (tab.conflict) {
    const deleted = tab.conflict.diskHash === null;
    return (
      <Callout
        tone="warning"
        className="nv-editor-banner"
        title={deleted ? editorCopy.conflictDeletedTitle : editorCopy.conflictTitle}
        action={
          <div className="nv-editor-banner__actions">
            {deleted ? null : (
              <Button size="sm" variant="secondary" onClick={() => void editor().reloadFromDisk(tab.path)}>
                {editorCopy.reload}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => void editor().keepMine(tab.path)}>
              {editorCopy.keepMine}
            </Button>
            {tab.conflict.diskContent !== null ? (
              <Button size="sm" variant="ghost" onClick={onCompare}>
                {editorCopy.compare}
              </Button>
            ) : null}
          </div>
        }
      >
        {deleted ? editorCopy.conflictDeletedDetail : editorCopy.conflictDetail}
      </Callout>
    );
  }
  if (tab.deletedOnDisk) {
    return (
      <Callout
        tone="info"
        className="nv-editor-banner"
        title={editorCopy.deletedTitle}
        action={
          <div className="nv-editor-banner__actions">
            <Button size="sm" variant="secondary" onClick={() => void editor().save(tab.path)}>
              {editorCopy.recreate}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => editor().closeTab(tab.path, true)}>
              {editorCopy.closeTabAction}
            </Button>
          </div>
        }
      >
        {editorCopy.deletedDetail}
      </Callout>
    );
  }
  if (tab.saveError) {
    const detail =
      tab.saveError.code === "invalid_request" ? editorCopy.saveTooLarge : describeUiError(tab.saveError).title;
    return (
      <Callout tone="danger" className="nv-editor-banner" title={editorCopy.saveErrorTitle}>
        {detail}
      </Callout>
    );
  }
  if (tab.kind === "text" && tab.size > LARGE_FILE_BYTES) {
    return (
      <Callout tone="info" className="nv-editor-banner">
        {editorCopy.largeFileHint(tab.size)}
      </Callout>
    );
  }
  return null;
}

function LoadingLines() {
  return (
    <div className="nv-editor-skeleton" aria-busy="true">
      <VisuallyHidden>{editorCopy.loading}</VisuallyHidden>
      {Array.from({ length: 12 }, (_, index) => (
        <Skeleton key={index} width={`${30 + ((index * 37) % 55)}%`} height={10} />
      ))}
    </div>
  );
}

function TabBody({ tab, bus }: { tab: EditorTab; bus: CursorBus }) {
  const store = useAtelierStore();
  const [comparing, setComparing] = useState(false);
  const onCursor = useCallback((cursor: CursorInfo) => bus.set(cursor), [bus]);

  if (tab.status === "idle" || tab.status === "loading") return <LoadingLines />;
  if (tab.status === "error") {
    return (
      <Callout
        tone="danger"
        className="nv-editor-state"
        title={editorCopy.readErrorTitle}
        action={
          <Button size="sm" onClick={() => void store.getState().editor.openFile(tab.path)}>
            {editorCopy.retry}
          </Button>
        }
      >
        {tab.error ? describeUiError(tab.error).title : null}
      </Callout>
    );
  }
  if (tab.kind === "binary") {
    return (
      <Callout tone="info" className="nv-editor-state" title={editorCopy.binaryTitle}>
        {editorCopy.binaryDetail}
      </Callout>
    );
  }
  if (tab.kind === "tooLarge") {
    return (
      <Callout tone="info" className="nv-editor-state" title={editorCopy.tooLargeTitle(tab.size)}>
        {editorCopy.tooLargeDetail}
      </Callout>
    );
  }
  const conflict = tab.conflict;
  return (
    <>
      <Banners tab={tab} onCompare={() => setComparing(true)} />
      {comparing && conflict?.diskContent != null ? (
        <CompareView
          path={tab.path}
          diskText={conflict.diskContent}
          mineText={store.getState().editor.buffers.get(tab.path)?.snapshot().text ?? ""}
          onCancel={() => setComparing(false)}
          onApply={(text) => {
            setComparing(false);
            store.getState().editor.applyMerged(tab.path, text);
          }}
        />
      ) : (
        <EditorSurface key={tab.version} tab={tab} onCursor={onCursor} />
      )}
    </>
  );
}

function EmptyEditor({ onQuickOpen }: { onQuickOpen: (() => void) | undefined }) {
  const store = useAtelierStore();
  const workspaceId = useAtelier((state) => state.editor.workspaceId);
  const closed = useAtelier((state) => state.editor.closed);
  const recent = useMemo(() => [...closed].reverse().slice(0, RECENT_SHOWN), [closed]);
  if (!workspaceId) {
    return (
      <EmptyState
        className="nv-editor-empty"
        headingLevel={3}
        title={editorCopy.noWorkspaceTitle}
        description={editorCopy.noWorkspaceDescription}
      />
    );
  }
  return (
    <EmptyState
      className="nv-editor-empty"
      headingLevel={3}
      icon={<SearchIcon size={24} />}
      title={editorCopy.emptyTitle}
      description={editorCopy.emptyDescription}
      action={
        <div className="nv-editor-empty__actions">
          {onQuickOpen ? (
            <Button variant="secondary" onClick={onQuickOpen}>
              {editorCopy.emptyQuickOpen} <Kbd>{MOD_KEY}+P</Kbd>
            </Button>
          ) : null}
          {recent.length > 0 ? (
            <div className="nv-editor-empty__recent">
              <h4>{editorCopy.emptyRecent}</h4>
              <ul>
                {recent.map((path) => (
                  <li key={path}>
                    <button type="button" className="nv-link-button" onClick={() => void store.getState().editor.openFile(path)}>
                      {path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

export function EditorWorkbench({ agentWritingPaths = EMPTY_SET, onQuickOpen, onProjectSearch }: EditorWorkbenchProps) {
  const store = useAtelierStore();
  const panelId = useId();
  const tabs = useAtelier((state) => state.editor.tabs);
  const activePath = useAtelier((state) => state.editor.activePath);
  const active = tabs.find((tab) => tab.path === activePath) ?? null;
  const [bus] = useState(createCursorBus);
  const pendingClose = useAtelier((state) => state.editor.pendingClose);
  const [announcement, setAnnouncement] = useState("");

  const requestClose = useCallback((path: string) => store.getState().editor.requestClose(path), [store]);

  const run = useCallback(
    async (command: AtelierCommand): Promise<boolean> => {
      const editor = store.getState().editor;
      const path = editor.activePath;
      switch (command.type) {
        case "save": {
          if (!path) return false;
          if (await editor.save(path)) setAnnouncement(editorCopy.saved(basenameOf(path)));
          return true;
        }
        case "saveAll":
          await editor.saveAll();
          return true;
        case "closeTab":
          if (path) requestClose(path);
          return path !== null;
        case "reopenTab":
          await editor.reopenClosed();
          return true;
        case "cycleRecent":
          editor.cycleRecent(command.direction);
          return true;
        case "cycleOrder":
          editor.cycleOrder(command.direction);
          return true;
        case "goToTab":
          return editor.goToTab(command.index);
        case "quickOpen":
          onQuickOpen?.();
          return onQuickOpen !== undefined;
        case "projectSearch":
          onProjectSearch?.();
          return onProjectSearch !== undefined;
        default:
          return false;
      }
    },
    [store, requestClose, onQuickOpen, onProjectSearch],
  );

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return;
    const command = resolveAtelierShortcut(event.nativeEvent);
    if (!command) return;
    if ((command.type === "quickOpen" && !onQuickOpen) || (command.type === "projectSearch" && !onProjectSearch)) return;
    event.preventDefault();
    void run(command);
  }

  const closingTab = pendingClose ? tabs.find((tab) => tab.path === pendingClose) : undefined;

  return (
    // Shortcuts bubble from the tabs, the editor and the banners inside this group.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section className="nv-workbench-editor" aria-label={editorCopy.workbenchLabel} onKeyDown={onKeyDown}>
      <EditorTabStrip panelId={panelId} agentWritingPaths={agentWritingPaths} requestClose={requestClose} />
      <div
        id={panelId}
        className="nv-workbench-editor__panel"
        role={active ? "tabpanel" : undefined}
        aria-label={active ? active.path : undefined}
      >
        {active ? (
          <>
            <div className="nv-editor-bar">
              <Breadcrumbs path={active.path} />
              <FileInfo tab={active} bus={bus} />
            </div>
            <TabBody key={active.path} tab={active} bus={bus} />
          </>
        ) : (
          <EmptyEditor onQuickOpen={onQuickOpen} />
        )}
      </div>
      <output className="nv-visually-hidden" aria-live="polite">
        {announcement}
      </output>
      <Dialog
        open={closingTab !== undefined}
        onClose={() => store.getState().editor.cancelClose()}
        size="sm"
        title={closingTab ? editorCopy.closeDirtyTitle(basenameOf(closingTab.path)) : ""}
        description={editorCopy.closeDirtyDetail}
        footer={
          closingTab ? (
            <>
              <Button variant="ghost" onClick={() => store.getState().editor.cancelClose()}>
                {editorCopy.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  store.getState().editor.cancelClose();
                  store.getState().editor.closeTab(closingTab.path, true);
                }}
              >
                {editorCopy.closeDirtyDiscard}
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  store.getState().editor.cancelClose();
                  if (await store.getState().editor.save(closingTab.path)) store.getState().editor.closeTab(closingTab.path);
                }}
              >
                {editorCopy.closeDirtySave}
              </Button>
            </>
          ) : null
        }
      />
    </section>
  );
}

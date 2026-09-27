// Tab strip of the editor group (VISUAL §5.1): tablist with roving focus, dirty dot, pin, Nomi
// orbit, drag to reorder with a keyboard alternative (Ctrl+Shift+PageUp/PageDown, WCAG 2.5.7).
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { OrbitIndicator } from "@nova/ui";
import type { EditorTab } from "../../state/editor-slice";
import { CloseIcon } from "../icons";
import { FileIcon } from "../files/file-icons";
import { useAtelier, useAtelierStore } from "./atelier-context";
import { editorCopy } from "./copy";

const NAME_MAX = 28;

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Shortens a long name in the middle, keeping its extension visible (VISUAL §5.1). */
export function middleEllipsis(name: string, max = NAME_MAX): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 && name.length - dot <= 8 ? name.slice(dot - 3) : name.slice(-6);
  return `${name.slice(0, Math.max(1, max - tail.length - 1))}…${tail}`;
}

function PinIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

interface TabMenuState {
  path: string;
  x: number;
  y: number;
}

export interface EditorTabStripProps {
  panelId: string;
  agentWritingPaths: ReadonlySet<string>;
  requestClose(path: string): void;
}

export function EditorTabStrip({ panelId, agentWritingPaths, requestClose }: EditorTabStripProps) {
  const store = useAtelierStore();
  const tabs = useAtelier((state) => state.editor.tabs);
  const activePath = useAtelier((state) => state.editor.activePath);
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Focus follows keyboard moves (arrows, reorder, menu close), never plain activation by the store. */
  const pendingFocus = useRef<string | null>(null);
  const [, setFocusRequest] = useState(0);
  const setFocusPath = (path: string) => {
    pendingFocus.current = path;
    setFocusRequest((value) => value + 1);
  };

  useLayoutEffect(() => {
    const path = pendingFocus.current;
    if (path === null) return;
    pendingFocus.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(path)}"]`)?.focus();
  });

  if (tabs.length === 0) return null;
  const editor = () => store.getState().editor;

  function onKeyDown(event: KeyboardEvent<HTMLElement>, tab: EditorTab, index: number) {
    const move = (target: EditorTab | undefined) => {
      if (!target) return;
      event.preventDefault();
      editor().activate(target.path, false);
      setFocusPath(target.path);
    };
    if (event.ctrlKey && event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) {
      event.preventDefault();
      editor().moveTab(tab.path, index + (event.key === "PageDown" ? 1 : -1));
      setFocusPath(tab.path);
      return;
    }
    switch (event.key) {
      case "ArrowRight":
        return move(tabs[(index + 1) % tabs.length]);
      case "ArrowLeft":
        return move(tabs[(index - 1 + tabs.length) % tabs.length]);
      case "Home":
        return move(tabs[0]);
      case "End":
        return move(tabs[tabs.length - 1]);
      case "Delete":
        event.preventDefault();
        requestClose(tab.path);
        return;
      case "ContextMenu":
        event.preventDefault();
        openMenu(tab.path, event.currentTarget);
        return;
      case "F10":
        if (event.shiftKey) {
          event.preventDefault();
          openMenu(tab.path, event.currentTarget);
        }
        return;
      default:
    }
  }

  function openMenu(path: string, anchor: HTMLElement, point?: { x: number; y: number }) {
    const rect = anchor.getBoundingClientRect();
    setMenu({ path, x: point?.x ?? rect.left, y: point?.y ?? rect.bottom });
  }

  function onDrop(event: DragEvent<HTMLElement>, index: number) {
    event.preventDefault();
    const path = event.dataTransfer.getData("application/x-nova-tab") || dragging;
    setDragging(null);
    if (path) editor().moveTab(path, index);
  }

  return (
    <div className="nv-tabstrip">
      <div ref={listRef} role="tablist" aria-label={editorCopy.tabsLabel} className="nv-tabstrip__list">
        {tabs.map((tab, index) => {
          const active = tab.path === activePath;
          const name = basenameOf(tab.path);
          const writing = agentWritingPaths.has(tab.path);
          const states = [tab.dirty ? editorCopy.unsaved : null, tab.pinned ? editorCopy.pinned : null, writing ? editorCopy.agentWriting : null]
            .filter(Boolean)
            .join(", ");
          return (
            <div
              key={tab.path}
              className="nv-tab"
              data-active={active || undefined}
              data-dirty={tab.dirty || undefined}
              data-dragging={dragging === tab.path || undefined}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, index)}
            >
              <button
                type="button"
                role="tab"
                id={`${panelId}-tab-${index}`}
                data-tab-path={tab.path}
                aria-selected={active}
                aria-controls={panelId}
                aria-label={states ? `${tab.path}, ${states}` : tab.path}
                title={tab.path}
                tabIndex={active || (activePath === null && index === 0) ? 0 : -1}
                className="nv-tab__main"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-nova-tab", tab.path);
                  event.dataTransfer.effectAllowed = "move";
                  setDragging(tab.path);
                }}
                onDragEnd={() => setDragging(null)}
                onClick={() => editor().activate(tab.path)}
                onAuxClick={(event: MouseEvent) => {
                  if (event.button === 1) requestClose(tab.path);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(tab.path, event.currentTarget, { x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => onKeyDown(event, tab, index)}
              >
                <span className="nv-tab__icon">
                  <FileIcon name={name} />
                </span>
                <span className="nv-tab__name">{middleEllipsis(name)}</span>
              </button>
              <span className="nv-tab__indicator">
                {writing ? (
                  <OrbitIndicator active size={12} label={editorCopy.agentWriting} />
                ) : tab.pinned ? (
                  <button
                    type="button"
                    className="nv-tab__action"
                    tabIndex={-1}
                    aria-label={`${editorCopy.unpin} ${name}`}
                    onClick={() => editor().setPinned(tab.path, false)}
                  >
                    <PinIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="nv-tab__action nv-tab__close"
                    tabIndex={-1}
                    aria-label={editorCopy.closeTab(name)}
                    onClick={() => requestClose(tab.path)}
                  >
                    <span className="nv-tab__dot" aria-hidden />
                    <span className="nv-tab__x">
                      <CloseIcon size={14} />
                    </span>
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {menu ? (
        <TabMenu
          menu={menu}
          pinned={tabs.find((tab) => tab.path === menu.path)?.pinned ?? false}
          onClose={() => {
            const path = menu.path;
            setMenu(null);
            setFocusPath(path);
          }}
          onPin={(pinned) => editor().setPinned(menu.path, pinned)}
          onCloseTab={() => requestClose(menu.path)}
          onCloseOthers={() => editor().closeOthers(menu.path)}
        />
      ) : null}
    </div>
  );
}

interface TabMenuProps {
  menu: TabMenuState;
  pinned: boolean;
  onClose(): void;
  onPin(pinned: boolean): void;
  onCloseTab(): void;
  onCloseOthers(): void;
}

function TabMenu({ menu, pinned, onClose, onPin, onCloseTab, onCloseOthers }: TabMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  const items: { label: string; run: () => void }[] = [
    { label: pinned ? editorCopy.unpin : editorCopy.pin, run: () => onPin(!pinned) },
    { label: editorCopy.closeTabAction, run: onCloseTab },
    { label: editorCopy.closeOthers, run: onCloseOthers },
  ];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={editorCopy.tabMenu(basenameOf(menu.path))}
      className="nv-menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="nv-menu__item"
          tabIndex={-1}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

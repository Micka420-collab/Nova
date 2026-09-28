// One CodeMirror view for the visible tab. Tabs keep their EditorState (CmDoc) while hidden; the
// view is rebuilt when the tab is shown again, or when the slice replaced its buffer (`version`).
import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { styleNonce } from "../../lib/csp-nonce";
import { TextDoc, type EditorTab } from "../../state/editor-slice";
import { useAtelier, useAtelierStore } from "./atelier-context";
import { CmDoc, cursorOf, LARGE_FILE_BYTES, type CursorInfo } from "./codemirror/setup";
import { loadLanguage } from "./codemirror/languages";
import { editorCopy } from "./copy";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface EditorSurfaceProps {
  /** The parent keys the surface by path and buffer version: a replaced buffer remounts the view. */
  tab: EditorTab;
  onCursor(cursor: CursorInfo): void;
}

export function EditorSurface({ tab, onCursor }: EditorSurfaceProps) {
  const store = useAtelierStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onCursorRef = useRef(onCursor);
  useLayoutEffect(() => {
    onCursorRef.current = onCursor;
  });
  const focusSeq = useAtelier((state) => state.editor.focusSeq);
  const reveal = useAtelier((state) => (state.editor.reveal?.path === tab.path ? state.editor.reveal : null));
  const { path } = tab;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = store.getState().editor;
    // Read at mount only: the size changes on each save and must not rebuild the view.
    const isLarge = () => (editor.tabs.find((item) => item.path === path)?.size ?? 0) > LARGE_FILE_BYTES;
    const existing = editor.buffers.get(path);
    let cmDoc: CmDoc;
    if (existing instanceof CmDoc) {
      cmDoc = existing;
    } else {
      const text = existing?.snapshot().text ?? "";
      cmDoc = new CmDoc(text, existing instanceof TextDoc ? existing.base : text, {
        label: editorCopy.editorLabel(basename(path)),
        nonce: styleNonce(),
        large: isLarge(),
      });
      editor.buffers.set(path, cmDoc);
    }
    const view = new EditorView({ state: cmDoc.state, parent: host });
    viewRef.current = view;
    cmDoc.listener = {
      dirtyChanged: (dirty) => store.getState().editor.setDirty(path, dirty),
      cursorChanged: (cursor) => onCursorRef.current(cursor),
    };
    onCursorRef.current(cursorOf(cmDoc.state));
    const scrollTop = editor.scroll.get(path);
    if (scrollTop) view.scrollDOM.scrollTop = scrollTop;

    let disposed = false;
    if (!cmDoc.languageLoaded && !isLarge()) {
      void loadLanguage(path).then((support) => {
        if (!disposed) cmDoc.applyLanguage(view, support);
      });
    }
    return () => {
      disposed = true;
      store.getState().editor.scroll.set(path, view.scrollDOM.scrollTop);
      if (cmDoc.listener) cmDoc.listener = null;
      viewRef.current = null;
      view.destroy();
    };
  }, [store, path]);

  // User-initiated opens move focus into the editor; agent-driven ones never do (POWER_UX 6.4).
  useEffect(() => {
    const view = viewRef.current;
    if (view && store.getState().editor.claimFocus(focusSeq)) view.focus();
  }, [focusSeq, store]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines));
    const from = Math.min(line.from + (reveal.from ?? 0), line.to);
    const to = Math.min(line.from + (reveal.to ?? reveal.from ?? 0), line.to);
    view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    store.getState().editor.consumeReveal(reveal.seq);
  }, [reveal, store]);

  return <div ref={hostRef} className="nv-editor-surface" data-path={path} />;
}

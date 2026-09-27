import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { installEditorDomPolyfills } from "../test-dom";
import { EDITOR_SHORTCUTS, novaEditorKeymap } from "./keymap";
import { CmDoc } from "./setup";

installEditorDomPolyfills();

function mount(text: string) {
  const doc = new CmDoc(text, text, { label: "Éditeur : test.ts", nonce: null, large: false });
  const view = new EditorView({ state: doc.state, parent: document.body });
  return { doc, view };
}

function press(view: EditorView, init: KeyboardEventInit & { key: string }) {
  return runScopeHandlers(view, new KeyboardEvent("keydown", init), "editor");
}

describe("editor keymap", () => {
  it("binds every documented shortcut, with unique ids and French labels", () => {
    const keys = novaEditorKeymap().map((binding) => binding.key);
    for (const shortcut of EDITOR_SHORTCUTS) {
      expect(keys).toContain(shortcut.key);
      for (const alternative of shortcut.alternatives ?? []) expect(keys).toContain(alternative);
      expect(shortcut.label.length).toBeGreaterThan(0);
    }
    expect(new Set(EDITOR_SHORTCUTS.map((shortcut) => shortcut.id)).size).toBe(EDITOR_SHORTCUTS.length);
  });

  it("Ctrl+G goes to a line instead of CodeMirror's find-next (POWER_UX 2.2)", () => {
    const { view } = mount("a\nb\nc\n");
    expect(press(view, { key: "g", ctrlKey: true })).toBe(true);
    expect(view.dom.querySelector("input[name='line']")).not.toBeNull();
    view.destroy();
  });

  it("Shift+Alt+Down adds a cursor (not copyLine) and Ctrl+Shift+Enter duplicates only without selection", () => {
    const { view } = mount("one\ntwo\n");
    press(view, { key: "ArrowDown", shiftKey: true, altKey: true });
    expect(view.state.selection.ranges).toHaveLength(2);
    expect(view.state.doc.toString()).toBe("one\ntwo\n");

    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("one\none\ntwo\n");

    view.dispatch({ selection: { anchor: 0, head: 3 } });
    press(view, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("one\none\ntwo\n");
    view.destroy();
  });

  it("tracks dirty against the disk text and reports only flips", () => {
    const { doc, view } = mount("hello");
    const flips: boolean[] = [];
    doc.listener = { dirtyChanged: (dirty) => flips.push(dirty), cursorChanged: () => undefined };
    view.dispatch({ changes: { from: 5, insert: "!" } });
    view.dispatch({ changes: { from: 6, insert: "!" } });
    view.dispatch({ changes: { from: 5, to: 7 } });
    expect(flips).toEqual([true, false]);
    view.destroy();
  });

  it("keeps edits typed during a save dirty", () => {
    const { doc, view } = mount("v1");
    view.dispatch({ changes: { from: 2, insert: "-a" } });
    const saving = doc.snapshot();
    view.dispatch({ changes: { from: 4, insert: "-b" } });
    expect(doc.markSaved(saving)).toBe(true);
    expect(doc.snapshot().text).toBe("v1-a-b");
    view.destroy();
  });

  it("puts the editor text in a labeled textbox", () => {
    const { view } = mount("x");
    expect(view.contentDOM.getAttribute("aria-label")).toBe("Éditeur : test.ts");
    expect(view.dom.classList.contains("nv-code-editor")).toBe(true);
    expect(EditorState.phrases).toBeDefined();
    view.destroy();
  });
});

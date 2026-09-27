// CodeMirror 6 configuration of the NOVA editor: pieces chosen explicitly (no basicSetup), classes
// for the theme (code.css), the CSP nonce for the few styles CodeMirror injects (ADR-013).
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Text, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import type { DocModel, DocSnapshot } from "../../../state/editor-slice";
import { novaHighlighter } from "./highlight";
import { novaEditorKeymap } from "./keymap";
import { frenchPhrases } from "./phrases";

/** Above this size the file opens without syntax highlighting or occurrence highlighting (POWER_UX 7.6). */
export const LARGE_FILE_BYTES = 1024 * 1024;

export interface EditorSetupOptions {
  /** Accessible name of the text area ("Éditeur : app.ts"). */
  label: string;
  /** Style nonce of this page load; null under the dev server. */
  nonce: string | null;
  large: boolean;
}

/** Everything the editor needs except the language, which arrives later through `languageSlot`. */
export function editorExtensions(options: EditorSetupOptions, languageSlot: Compartment, onUpdate: (update: ViewUpdate) => void): Extension[] {
  return [
    options.nonce ? EditorView.cspNonce.of(options.nonce) : [],
    frenchPhrases,
    EditorView.editorAttributes.of({ class: "nv-code-editor" }),
    EditorView.contentAttributes.of({ "aria-label": options.label }),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    // Alt+click adds a cursor; Shift+Alt+drag selects a rectangle (FEATURES E3).
    EditorView.clickAddsSelectionRange.of((event) => event.altKey && !event.shiftKey),
    rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
    crosshairCursor({ key: "Alt" }),
    indentOnInput(),
    syntaxHighlighting(novaHighlighter),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    highlightActiveLine(),
    options.large ? [] : highlightSelectionMatches(),
    search({ top: true }),
    languageSlot.of([]),
    Prec.high(keymap.of(novaEditorKeymap())),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of(onUpdate),
  ];
}

export interface CursorInfo {
  line: number;
  column: number;
  selections: number;
}

export function cursorOf(state: EditorState): CursorInfo {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1, selections: state.selection.ranges.length };
}

/** Hooks a mounted surface attaches to a CodeMirror buffer. */
export interface CmDocListener {
  dirtyChanged(dirty: boolean): void;
  cursorChanged(cursor: CursorInfo): void;
}

/**
 * CodeMirror-backed buffer: keeps the full EditorState (history, selections, folds) of a tab while
 * other tabs are shown. Dirty = the document differs from `base`, the text last known on disk.
 */
export class CmDoc implements DocModel {
  state: EditorState;
  base: Text;
  dirty: boolean;
  languageLoaded = false;
  listener: CmDocListener | null = null;
  readonly language = new Compartment();

  constructor(text: string, base: string, options: EditorSetupOptions) {
    this.state = EditorState.create({
      doc: text,
      extensions: editorExtensions(options, this.language, (update) => this.onUpdate(update)),
    });
    this.base = text === base ? this.state.doc : Text.of(base.split("\n"));
    this.dirty = !this.state.doc.eq(this.base);
  }

  private onUpdate(update: ViewUpdate): void {
    this.state = update.state;
    if (update.docChanged) {
      const dirty = !update.state.doc.eq(this.base);
      if (dirty !== this.dirty) {
        this.dirty = dirty;
        this.listener?.dirtyChanged(dirty);
      }
    }
    if (update.docChanged || update.selectionSet) this.listener?.cursorChanged(cursorOf(update.state));
  }

  snapshot(): DocSnapshot {
    return { text: this.state.doc.toString(), token: this.state.doc };
  }

  markSaved(saved: DocSnapshot): boolean {
    // A snapshot taken before this buffer replaced a plain TextDoc carries a string token.
    this.base = saved.token instanceof Text ? saved.token : Text.of(saved.text.split("\n"));
    this.dirty = !this.state.doc.eq(this.base);
    return this.dirty;
  }

  applyLanguage(view: EditorView, support: LanguageSupport | null): void {
    this.languageLoaded = true;
    if (support) view.dispatch({ effects: this.language.reconfigure(support) });
  }
}

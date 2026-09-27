// Editor shortcuts (POWER_UX §2.2 "Éditeur"), declared once: the same table builds the CodeMirror
// keymap and the shortcut sheet, so the sheet cannot drift from what the keys really do (E3).
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  deleteLine,
  moveLineDown,
  moveLineUp,
  simplifySelection,
  temporarilySetTabFocusMode,
  toggleComment,
  toggleTabFocusMode,
} from "@codemirror/commands";
import { foldCode, unfoldCode } from "@codemirror/language";
import { closeSearchPanel, gotoLine, openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { Command, KeyBinding } from "@codemirror/view";

export interface EditorShortcut {
  id: string;
  /** French description shown in the shortcut sheet. */
  label: string;
  /** CodeMirror key names (`Mod` = Ctrl, or Cmd on macOS). */
  key: string;
  mac?: string;
  /** Extra keys for the same command (AZERTY-friendly alternatives). */
  alternatives?: string[];
  run: Command;
}

/** Duplicate the line only with an empty selection; with a selection the key belongs to "Diviser". */
const duplicateLineWhenEmpty: Command = (view) =>
  view.state.selection.ranges.every((range) => range.empty) ? copyLineDown(view) : false;

/**
 * Escape closes the search panel, then collapses selections; when there is nothing left to close,
 * the next Tab leaves the editor (WCAG 2.1.2, no keyboard trap).
 */
const escapeThenTab: Command = (view) =>
  closeSearchPanel(view) || simplifySelection(view) || temporarilySetTabFocusMode(view);

/**
 * Bindings NOVA adds or overrides on top of CodeMirror's default, search, history, fold and
 * completion keymaps (which stay active underneath).
 */
export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = [
  { id: "search.find", label: "Chercher dans le fichier", key: "Mod-f", run: openSearchPanel },
  { id: "search.replace", label: "Chercher et remplacer", key: "Mod-h", mac: "Mod-Alt-f", run: openSearchPanel },
  { id: "editor.gotoLine", label: "Aller à la ligne", key: "Ctrl-g", run: gotoLine },
  { id: "editor.nextOccurrence", label: "Ajouter l'occurrence suivante", key: "Mod-d", run: selectNextOccurrence },
  { id: "editor.allOccurrences", label: "Sélectionner toutes les occurrences", key: "Mod-Shift-l", run: selectSelectionMatches },
  { id: "editor.cursorAbove", label: "Curseur au-dessus", key: "Shift-Alt-ArrowUp", mac: "Mod-Alt-ArrowUp", run: addCursorAbove },
  { id: "editor.cursorBelow", label: "Curseur en dessous", key: "Shift-Alt-ArrowDown", mac: "Mod-Alt-ArrowDown", run: addCursorBelow },
  { id: "editor.moveLineUp", label: "Déplacer la ligne vers le haut", key: "Alt-ArrowUp", run: moveLineUp },
  { id: "editor.moveLineDown", label: "Déplacer la ligne vers le bas", key: "Alt-ArrowDown", run: moveLineDown },
  { id: "editor.duplicateLine", label: "Dupliquer la ligne (sans sélection)", key: "Mod-Shift-Enter", run: duplicateLineWhenEmpty },
  { id: "editor.deleteLine", label: "Supprimer la ligne", key: "Mod-Shift-k", run: deleteLine },
  { id: "editor.toggleComment", label: "Commenter", key: "Mod-/", run: toggleComment },
  {
    id: "editor.fold",
    label: "Plier",
    key: "Ctrl-Shift-[",
    mac: "Mod-Alt-[",
    alternatives: ["Mod-Shift-,"],
    run: foldCode,
  },
  {
    id: "editor.unfold",
    label: "Déplier",
    key: "Ctrl-Shift-]",
    mac: "Mod-Alt-]",
    alternatives: ["Mod-Shift-."],
    run: unfoldCode,
  },
  { id: "a11y.toggleTabFocus", label: "Tab déplace le focus (bascule)", key: "Ctrl-m", mac: "Shift-Alt-m", run: toggleTabFocusMode },
  { id: "a11y.leaveEditor", label: "Sortir de l'éditeur : Échap puis Tab", key: "Escape", run: escapeThenTab },
];

/** CodeMirror bindings built from the table (use with a high precedence over the default keymaps). */
export function novaEditorKeymap(): KeyBinding[] {
  return EDITOR_SHORTCUTS.flatMap((shortcut) => [
    { key: shortcut.key, ...(shortcut.mac ? { mac: shortcut.mac } : {}), run: shortcut.run, preventDefault: true },
    ...(shortcut.alternatives ?? []).map((key) => ({ key, run: shortcut.run, preventDefault: true })),
  ]);
}

// French phrases for CodeMirror's built-in UI (search panel, folding, merge view, go to line).
import { EditorState, type Extension } from "@codemirror/state";

export const FRENCH_PHRASES: Record<string, string> = {
  Find: "Rechercher",
  Replace: "Remplacer",
  next: "suivant",
  previous: "précédent",
  all: "tout",
  "match case": "respecter la casse",
  regexp: "expression régulière",
  "by word": "mot entier",
  replace: "remplacer",
  "replace all": "tout remplacer",
  close: "fermer",
  "current match": "occurrence courante",
  "on line": "à la ligne",
  "replaced match on line $": "occurrence remplacée à la ligne $",
  "replaced $ matches": "$ occurrences remplacées",
  "Go to line": "Aller à la ligne",
  go: "aller",
  "Folded lines": "Lignes pliées",
  "Unfolded lines": "Lignes dépliées",
  to: "à",
  "folded code": "code plié",
  unfold: "déplier",
  "Fold line": "Plier la ligne",
  "Unfold line": "Déplier la ligne",
  "Control character": "Caractère de contrôle",
  "Selection deleted": "Sélection supprimée",
  Completions: "Complétions",
  "$ unchanged lines": "$ lignes inchangées",
  Accept: "Garder",
  Reject: "Refuser",
  "Revert this chunk": "Reprendre ce bloc du disque",
};

export const frenchPhrases: Extension = EditorState.phrases.of(FRENCH_PHRASES);

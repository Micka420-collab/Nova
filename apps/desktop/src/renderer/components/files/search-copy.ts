// French UI copy of quick open and project search (to merge into copy/fr.ts by the lead).

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const quickOpenCopy = {
  title: "Ouvrir un fichier",
  inputLabel: "Ouvrir un fichier",
  placeholder: "Nom de fichier (ajoute :42 pour une ligne)",
  groupRecent: "Récents",
  groupResults: "Fichiers",
  noWorkspace: "Ouvre un dossier pour chercher des fichiers.",
  noRecent: "Tape un nom de fichier pour chercher dans le projet.",
  loading: "Recherche…",
  empty: (query: string) => `Aucun fichier ne correspond à « ${query} ».`,
  truncated: "Résultats partiels : affine ta recherche.",
  lineHint: (line: number) => `ligne ${line}`,
} as const;

export const projectSearchCopy = {
  region: "Rechercher dans le projet",
  title: "Rechercher",
  pattern: "Rechercher",
  replace: "Remplacer",
  caseSensitive: "Respecter la casse",
  wholeWord: "Mot entier",
  regex: "Expression régulière",
  include: "Fichiers à inclure",
  exclude: "Fichiers à exclure",
  globPlaceholder: "ex. src/**, *.ts",
  close: "Fermer la recherche",
  noWorkspace: "Ouvre un dossier pour chercher dans ses fichiers.",
  hint: "Tape un texte à chercher dans tout le projet.",
  searching: "Recherche…",
  invalidRegex: (detail: string) => `Expression régulière invalide : ${detail}`,
  empty: (pattern: string) => `Aucun résultat pour « ${pattern} ».`,
  summary: (matches: number, files: number, truncated: boolean) =>
    `${plural(matches, "résultat", "résultats")} dans ${plural(files, "fichier", "fichiers")}${truncated ? " · résultats partiels" : ""}`,
  groupLabel: (path: string, count: number) => `${path}, ${plural(count, "résultat", "résultats")}`,
  lineLabel: (line: number, text: string) => `Ligne ${line} : ${text}`,
  preview: "Aperçu du remplacement",
  hidePreview: "Masquer l'aperçu",
  apply: (files: number) => `Remplacer dans ${plural(files, "fichier", "fichiers")}`,
  applying: "Remplacement…",
  includeFile: (path: string) => `Inclure ${path}`,
  dirtySkipped: "non enregistré dans l'éditeur : ignoré",
  before: "Avant",
  after: "Après",
  resultTitle: (replacements: number, files: number) =>
    `${plural(replacements, "remplacement", "remplacements")} dans ${plural(files, "fichier", "fichiers")}`,
  resultNone: "Aucun fichier n'a été modifié.",
  skippedDirty: (path: string) => `${path} : non enregistré dans l'éditeur, ignoré.`,
  skippedConflict: (path: string) => `${path} : modifié entre-temps, rien n'a été écrit.`,
  skippedUnreadable: (path: string) => `${path} : fichier binaire ou trop volumineux, ignoré.`,
  skippedMismatch: (path: string, previewed: number, found: number) =>
    `${path} : ${found} occurrence${found > 1 ? "s" : ""} dans le fichier, ${previewed} dans l'aperçu (résultats tronqués ou ligne coupée) : rien n'a été écrit.`,
  skippedError: (path: string, reason: string) => `${path} : ${reason}`,
  checkpointLabel: (pattern: string) => `Remplacer « ${pattern.length > 60 ? `${pattern.slice(0, 59)}…` : pattern} »`,
  checkpointFailed: (reason: string) => `Le point de reprise n'a pas pu être créé : rien n'a été remplacé (${reason}).`,
  undoHint: "Annulable depuis Points de reprise.",
} as const;

// French UI copy of the editor (to be merged into copy/fr.ts by the lead). Code stays English.

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

export const editorCopy = {
  workbenchLabel: "Éditeur",
  tabsLabel: "Fichiers ouverts",
  editorLabel: (name: string) => `Éditeur : ${name}`,
  closeTab: (name: string) => `Fermer ${name}`,
  unsaved: "non enregistré",
  pinned: "épinglé",
  agentWriting: "Nomi modifie ce fichier",
  pin: "Épingler",
  unpin: "Désépingler",
  closeOthers: "Fermer les autres",
  tabMenu: (name: string) => `Actions pour ${name}`,
  breadcrumbsLabel: "Chemin du fichier",
  statusLabel: "Informations du fichier",
  lineColumn: (line: number, column: number) => `Ln ${line}, Col ${column}`,
  selections: (count: number) => `${count} sélections`,
  plainText: "Texte brut",
  encoding: "UTF-8",
  eol: { lf: "LF", crlf: "CRLF" } as const,
  size: sizeLabel,

  emptyTitle: "Ouvre un fichier ou demande à Nomi",
  emptyDescription: "Choisis un fichier dans l'explorateur, ou ouvre-le au clavier.",
  emptyQuickOpen: "Ouvrir un fichier…",
  emptyRecent: "Récemment ouverts",
  noWorkspaceTitle: "Aucun dossier ouvert",
  noWorkspaceDescription: "Ouvre un dossier de projet pour voir et modifier ses fichiers.",
  loading: "Lecture du fichier…",
  readErrorTitle: "Fichier illisible",
  retry: "Réessayer",
  binaryTitle: "Fichier binaire",
  binaryDetail: "NOVA ne l'ouvre pas dans l'éditeur pour ne pas l'abîmer.",
  tooLargeTitle: (bytes: number) => `${sizeLabel(bytes)} : trop gros pour l'éditeur`,
  tooLargeDetail: "Au-delà de 5 Mo, ouvre-le avec un outil externe ou dans le terminal (less).",
  largeFileHint: (bytes: number) => `Gros fichier (${sizeLabel(bytes)}) : coloration désactivée pour rester fluide.`,

  saveErrorTitle: "Le fichier n'a pas été enregistré",
  saveTooLarge: "Le contenu dépasse 5 Mo : il ne peut pas être enregistré depuis l'éditeur.",
  conflictTitle: "Le fichier a changé sur le disque",
  conflictDetail: "Tes modifications ne sont pas enregistrées. Choisis la version à garder.",
  conflictDeletedTitle: "Le fichier a été supprimé du disque",
  conflictDeletedDetail: "Tes modifications ne sont pas enregistrées. Tu peux le recréer avec ta version.",
  reload: "Recharger",
  keepMine: "Garder ma version",
  compare: "Comparer",
  deletedTitle: "Ce fichier n'existe plus sur le disque",
  deletedDetail: "Son contenu reste ici tant que l'onglet est ouvert.",
  recreate: "Le recréer",
  closeTabAction: "Fermer l'onglet",

  compareLabel: "Comparaison avec le disque",
  compareDisk: "Sur le disque",
  compareMine: "Ta version (modifiable)",
  compareApply: "Utiliser ce résultat",
  compareCancel: "Fermer la comparaison",
  compareHint: "Les flèches de la marge copient un bloc du disque dans ta version.",

  closeDirtyTitle: (name: string) => `Enregistrer les modifications de ${name} ?`,
  closeDirtyDetail: "Si tu fermes sans enregistrer, tes modifications seront perdues.",
  closeDirtySave: "Enregistrer",
  closeDirtyDiscard: "Ne pas enregistrer",
  cancel: "Annuler",

  saved: (name: string) => `${name} enregistré`,
} as const;

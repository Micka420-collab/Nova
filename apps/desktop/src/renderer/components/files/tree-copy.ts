// French UI copy of the file tree (to be merged into copy/fr.ts by the lead).
import type { GitLetter } from "../../state/workspace-slice";

export const treeCopy = {
  label: "Fichiers du projet",
  noWorkspace: "Aucun dossier ouvert",
  empty: "Aucun fichier",
  loading: "Chargement du dossier…",
  unreadable: "Dossier illisible",
  retry: "Réessayer",
  outside: "Hors du projet : non suivi.",
  ignored: "ignoré",
  agentTouched: "touché par Nomi",
  menuLabel: (name: string) => `Actions pour « ${name} »`,
  rootMenuLabel: "Actions du projet",
  newFile: "Nouveau fichier",
  newFolder: "Nouveau dossier",
  rename: "Renommer",
  trash: "Mettre à la corbeille",
  copyPath: "Copier le chemin",
  pathCopied: "Chemin copié",
  copyFailed: "Le chemin n'a pas pu être copié",
  newFileInput: "Nom du nouveau fichier",
  newFolderInput: "Nom du nouveau dossier",
  renameInput: (name: string) => `Nouveau nom de « ${name} »`,
  nameEmpty: "Donne un nom.",
  nameInvalid: "Nom invalide : pas de « / », de « \\ », ni « . » ou « .. ».",
  trashTitle: (name: string) => `Mettre « ${name} » à la corbeille ?`,
  trashBody: "Tu pourras le récupérer depuis la corbeille du système.",
  trashConfirm: "Mettre à la corbeille",
  cancel: "Annuler",
} as const;

export const GIT_STATUS_COPY: Record<GitLetter, string> = {
  M: "modifié",
  A: "ajouté",
  D: "supprimé",
  R: "renommé",
  "?": "non suivi par Git",
  "!": "en conflit",
};

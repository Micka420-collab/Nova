// French copy of lane L1 (agent terminal, background processes). Owned by L1.
import type { IpcErrorCode } from "@nova/shared";

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

export const processesCopy = {
  display: {
    list: (count: number) => (count === 0 ? "Aucun processus en arrière-plan" : plural(count, "processus en arrière-plan", "processus en arrière-plan")),
    stopped: "Processus arrêté",
    alreadyEnded: "Processus déjà terminé",
    running: "en cours",
    exited: (code: number | null) => (code === null ? "terminé (code inconnu)" : `terminé (code ${code})`),
    stoppedState: "arrêté",
    noOutput: "Aucune sortie pour l’instant.",
  },
  panel: {
    title: "Processus en arrière-plan",
    summary: (running: number, total: number) =>
      running === 0 ? plural(total, "processus terminé", "processus terminés") : `${plural(running, "en cours", "en cours")} sur ${total}`,
    loading: "Chargement des processus…",
    running: "En cours",
    exited: (code: number | null) => (code === null ? "Terminé · code inconnu" : code === 0 ? "Terminé · code 0" : `Échec · code ${code}`),
    stopped: "Arrêté",
    cwd: (cwd: string) => `dossier : ${cwd === "" ? "racine du projet" : cwd}`,
    pid: (pid: number | null) => (pid === null ? "PID inconnu" : `PID ${pid}`),
    stop: "Arrêter",
    stopLabel: (command: string) => `Arrêter ${command}`,
    showTerminal: "Voir le terminal",
    showOutput: "Voir la sortie",
    hideOutput: "Masquer la sortie",
    refreshOutput: "Actualiser",
    outputLabel: (command: string) => `Dernière sortie de ${command}`,
    outputTruncated: (shown: number, total: number) => `Les ${shown} derniers caractères sur ${total}.`,
    noOutput: "Aucune sortie pour l’instant.",
    stoppedAnnouncement: (command: string) => `${command} est arrêté.`,
    retry: "Réessayer",
    loadFailed: "Impossible de lire les processus de la mission.",
    readOnlyNote: "Nomi lance ces processus dans un terminal en lecture seule : « Prendre la main » dans le terminal te laisse saisir.",
  },
  terminal: {
    mirrorNote: "Nomi affiche ici les commandes qu’elle exécute. Cette session ne prend pas de saisie.",
  },
  errors: {
    not_found: "Ce processus n’existe plus (NOVA a pu redémarrer).",
    unavailable: "Le suivi des processus est indisponible pour le moment.",
    other: "L’action n’a pas abouti. Réessaie.",
  } as const,
} as const;

export function processErrorCopy(code: IpcErrorCode | null): string {
  if (code === "not_found") return processesCopy.errors.not_found;
  if (code === "unavailable") return processesCopy.errors.unavailable;
  return processesCopy.errors.other;
}

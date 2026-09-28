// French copy of lane L1 (agent terminal, background processes). Owned by L1.
const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

export const processesCopy = {
  display: {
    list: (count: number) => (count === 0 ? "Aucun processus en arrière-plan" : plural(count, "processus en arrière-plan", "processus en arrière-plan")),
    stopped: "Processus arrêté",
    running: "en cours",
    exited: (code: number | null) => (code === null ? "terminé (code inconnu)" : `terminé (code ${code})`),
    stoppedState: "arrêté",
    noOutput: "Aucune sortie pour l’instant.",
  },
} as const;

// French copy of the native desktop surfaces (tray menu, quit dialog, background notice). Main owns
// these strings because the OS renders them, not the renderer.

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

export const desktopCopy = {
  appName: "NOVA",
  open: "Ouvrir NOVA",
  quitApp: "Quitter NOVA",
  missionsMenu: (count: number) => (count > 0 ? `Missions en cours (${count})` : "Missions en cours"),
  noMission: "Aucune mission en cours",
  missionsUnknown: "Liste des missions indisponible",
  missionWaiting: "attend ton accord",
  status: {
    idle: "Nomi : au repos",
    unknown: "Nomi : état inconnu, NOVA n'a pas pu tout vérifier",
    working: (missions: number) => `Nomi travaille : ${plural(missions, "mission en cours", "missions en cours")}`,
    processes: (count: number) => `Nomi : ${plural(count, "processus en arrière-plan", "processus en arrière-plan")}`,
    waiting: (approvals: number) => `Nomi attend ta décision : ${plural(approvals, "approbation", "approbations")}`,
  },
  backgroundNotice: "NOVA continue en arrière-plan. Retrouve Nomi dans la barre système pour rouvrir ou quitter.",
  backgroundNoticeNoTray: "NOVA continue en arrière-plan : la fenêtre est réduite, car la barre système n'est pas disponible.",
  quit: {
    title: "Quitter NOVA ?",
    message: "Des tâches sont en cours.",
    intro: "Si tu quittes maintenant, ceci s'arrêtera :",
    missions: (count: number, titles: string) => `${plural(count, "mission en cours", "missions en cours")}${titles ? ` : ${titles}` : ""}`,
    approvals: (count: number) => `${plural(count, "approbation en attente", "approbations en attente")} (la mission ne pourra pas continuer)`,
    terminals: (count: number) => `${plural(count, "terminal ouvert", "terminaux ouverts")}`,
    processes: (count: number) => `${plural(count, "processus lancé par une mission", "processus lancés par des missions")}`,
    schedules: (count: number, next: string | null) =>
      `${plural(count, "planning actif", "plannings actifs")} : aucune exécution tant que NOVA est fermé${next ? ` (prochaine prévue ${next})` : ""}`,
    unreadable: "NOVA n'a pas pu tout vérifier : d'autres tâches peuvent être en cours.",
    cancel: "Annuler",
    confirm: "Quitter quand même",
  },
} as const;

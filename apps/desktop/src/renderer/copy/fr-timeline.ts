// French copy of lane L8 (missions « jusqu'à preuve », recherche dans la chronologie, bifurcation).
import type { ContinuationStopReason, MissionEventType } from "@nova/shared";

export const CONTINUATION_STOP_COPY: Record<ContinuationStopReason, { title: string; detail: string }> = {
  proven: { title: "Preuve obtenue", detail: "Tous les critères vérifiables sont prouvés par un résultat d’outil." },
  max_rounds: { title: "Nombre de tours atteint", detail: "Les critères ne sont pas tous prouvés après le dernier tour autorisé." },
  budget: {
    title: "Plafond de poursuite atteint",
    detail: "Un tour de plus dépasserait le plafond prévu pour la poursuite, ou le budget de la mission (ou un coût est inconnu).",
  },
  no_progress: { title: "Aucun progrès", detail: "Le dernier tour n’a rien changé : NOVA s’arrête plutôt que de tourner en rond." },
  user: { title: "Arrêtée par toi", detail: "La mission a été arrêtée pendant la poursuite." },
  manual_only: { title: "Rien à prouver automatiquement", detail: "Les critères restants sont à confirmer par toi : aucun tour n’est lancé pour eux." },
};

/** What an event of the journal is, for a search result (unknown types read « Événement »). */
export const EVENT_TYPE_LABELS: Partial<Record<MissionEventType, string>> = {
  "mission.created": "Mission créée",
  "mission.started": "Mission lancée",
  "mission.plan": "Plan",
  "task.updated": "Étape",
  "tool.requested": "Outil demandé",
  "tool.permission": "Décision de permission",
  "tool.started": "Outil lancé",
  "tool.finished": "Résultat d’outil",
  "approval.requested": "Approbation demandée",
  "approval.resolved": "Approbation",
  "message.completed": "Réponse de Nomi",
  "proof.recorded": "Preuve",
  "checkpoint.created": "Point de restauration",
  "budget.updated": "Budget",
  "mission.suspended": "Mission suspendue",
  "mission.resumed": "Mission reprise",
  "mission.succeeded": "Mission réussie",
  "mission.failed": "Mission échouée",
  "mission.cancelled": "Mission arrêtée",
  "review.decided": "Revue",
  "process.started": "Processus lancé",
  "process.ended": "Processus terminé",
  "compaction.applied": "Résumé appliqué",
  "handoff.created": "Dossier de passation",
  "model.switched": "Changement de modèle",
  "skill.loaded": "Skill chargée",
  "chain.finished": "Programme « Chaîne »",
  "submission.started": "Sous-mission",
  "submission.updated": "Sous-mission",
  "continuation.round": "Tour de poursuite",
  "continuation.stopped": "Fin de la poursuite",
  "mission.forked": "Bifurcation",
};

export const timelineCopy = {
  eventFallback: "Événement",
  continuation: {
    heading: "Jusqu’à preuve",
    round: (round: number, max: number) => `Tour ${round} sur ${max}`,
    unproven: (count: number) => (count === 0 ? "aucun critère en attente" : `${count} critère${count > 1 ? "s" : ""} à prouver`),
    running: (rounds: number, max: number | null) =>
      max === null ? `${rounds} tour${rounds > 1 ? "s" : ""} de poursuite` : `Poursuite : tour ${rounds} sur ${max}`,
    stopped: (title: string, rounds: number) => (rounds === 0 ? title : `${title} · ${rounds} tour${rounds > 1 ? "s" : ""}`),
  },
  forkOrigin: {
    label: (seq: number) => `Bifurquée d’une autre mission, à partir de son événement n° ${seq}.`,
    open: "Voir la mission d’origine",
  },
  option: {
    label: "Jusqu’à preuve",
    description:
      "Si la mission se termine alors que des critères vérifiables (tests, commandes, fichiers) ne sont pas prouvés, NOVA relance l’agent pour un nouveau tour, " +
      "dans les limites ci-dessous. Chaque tour garde tes règles et tes approbations. NOVA s’arrête dès que tout est prouvé, ou si un tour n’apporte rien.",
    rounds: "Tours au maximum",
    roundsHint: (max: number) => `De 1 à ${max}.`,
    budget: "Plafond pour la poursuite ($)",
    budgetHint: (mission: string) => `Compris dans le budget de la mission (${mission}), jamais en plus.`,
    manualOnly: "Tous les critères de ce plan sont à confirmer par toi : cette option ne lancera aucun tour.",
    errors: {
      rounds: (max: number) => `Un nombre entier de 1 à ${max}.`,
      budget: "Un montant positif, par exemple 0,20.",
      overMission: "Le plafond ne peut pas dépasser le budget de la mission.",
    },
  },
  search: {
    region: "Recherche dans la chronologie",
    label: "Rechercher dans les missions",
    placeholder: "Un mot, un fichier, une erreur…",
    submit: "Rechercher",
    scope: "Portée",
    scopeMission: "Cette mission",
    scopeWorkspace: "Ce projet",
    scopeAll: "Tous les projets",
    searching: "Recherche…",
    empty: (query: string) => `Aucun événement ne contient « ${query} ».`,
    results: (count: number) => `${count} résultat${count > 1 ? "s" : ""}`,
    capped: (count: number) => `Les ${count} plus récents sont affichés.`,
    failed: "La recherche n’a pas abouti.",
    event: (seq: number) => `événement n° ${seq}`,
    open: "Ouvrir",
    hint: "Les secrets sont masqués dans les extraits.",
  },
  fork: {
    resume: "Reprendre d’ici",
    resumeHint: "Nouvelle mission avec le même objectif, préparée à partir de ce qui s’est passé jusqu’ici.",
    branch: "Bifurquer d’ici",
    branchHint: "Nouvelle mission avec un autre objectif, à partir de ce moment.",
    goal: "Nouvel objectif",
    goalHint: "Laisse vide pour garder l’objectif d’origine.",
    confirm: "Préparer la mission",
    cancel: "Annuler",
    preparing: "Préparation du plan…",
    noEffect:
      "Rien n’est rejoué : la nouvelle mission part de l’état actuel du projet, avec un nouveau plan, un nouveau contrat à accepter et de nouvelles approbations. La mission d’origine ne change pas.",
    ready: (title: string) => `Mission prête : « ${title} ». Relis son plan et son contrat avant de la lancer.`,
    openReady: "Voir le plan",
    failed: "La nouvelle mission n’a pas pu être préparée.",
  },
} as const;

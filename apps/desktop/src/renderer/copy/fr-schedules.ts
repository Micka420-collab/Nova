// French copy of lane L6 (scheduled missions). Owned by L6.
import type { IpcErrorCode, MissedRunPolicy, ScheduleRunOutcome, ScheduleState } from "@nova/shared";

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/** 0 = Sunday … 6 = Saturday; shown Monday first. */
export const WEEKDAY_LABELS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;
export const WEEKDAY_SHORT = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"] as const;
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const schedulesCopy = {
  title: "Missions planifiées",
  intro: "Nomi lance une mission à l’heure que tu choisis, avec le contrat et le budget fixés ici.",
  onlyWhileOpen:
    "Les missions planifiées tournent seulement quand NOVA est ouvert (ou réduit dans la barre système). Si NOVA est fermé à l’heure prévue, la politique de retard s’applique.",
  sameRules:
    "Chaque exécution est une mission normale : même contrat, même budget, mêmes approbations. Une demande d’approbation attend ta réponse, même la nuit.",
  loading: "Chargement des planifications…",
  loadFailed: "Impossible de lire les planifications.",
  retry: "Réessayer",
  empty: "Aucune mission planifiée",
  emptyHint: "Par exemple : chaque matin à 9 h, lancer les tests et résumer ce qui casse.",
  create: "Nouvelle planification",
  list: "Planifications",
  count: (count: number) => plural(count, "planification", "planifications"),

  state: {
    active: "Active",
    paused: "En pause",
    completed: "Terminée",
  } satisfies Record<ScheduleState, string>,
  next: (when: string) => `Prochaine exécution : ${when}`,
  noNext: "Aucune exécution à venir",
  last: (when: string) => `Dernière exécution : ${when}`,
  neverRan: "Pas encore exécutée",
  timeZoneNote: (zone: string) => `heures du fuseau ${zone}`,

  pause: "Mettre en pause",
  pauseLabel: (title: string) => `Mettre en pause ${title}`,
  resume: "Reprendre",
  resumeLabel: (title: string) => `Reprendre ${title}`,
  edit: "Modifier",
  editLabel: (title: string) => `Modifier ${title}`,
  history: "Historique",
  historyLabel: (title: string) => `Historique de ${title}`,
  hideHistory: "Masquer l’historique",
  remove: "Supprimer",
  removeLabel: (title: string) => `Supprimer ${title}`,
  removeConfirm: (title: string) => `Supprimer « ${title} » et son historique ? Les missions déjà lancées restent.`,
  removeYes: "Supprimer définitivement",
  removeNo: "Annuler",
  pausedAnnouncement: (title: string) => `« ${title} » est en pause : aucune nouvelle exécution.`,
  resumedAnnouncement: (title: string) => `« ${title} » reprend.`,
  removedAnnouncement: (title: string) => `« ${title} » est supprimée.`,
  savedAnnouncement: (title: string) => `« ${title} » est enregistrée.`,
  pauseNote: "Une exécution en cours continue ; la pause empêche seulement les suivantes.",

  runs: {
    title: "Historique des exécutions",
    loading: "Chargement de l’historique…",
    empty: "Aucune exécution pour l’instant.",
    failed: "Impossible de lire l’historique.",
    due: (when: string) => `Prévue ${when}`,
    openMission: "Ouvrir la mission",
    outcome: {
      running: "En cours",
      succeeded: "Réussie",
      failed: "Échouée",
      cancelled: "Arrêtée",
      suspended: "Suspendue (attend ta décision)",
      skipped_missed: "Manquée",
      skipped_overlap: "Sautée : l’exécution précédente n’était pas finie",
      skipped_budget: "Sautée : plafond de dépense du jour atteint",
      error: "N’a pas pu démarrer",
    } satisfies Record<ScheduleRunOutcome, string>,
    detail: {
      nova_closed: "NOVA était fermé",
      late: "NOVA n’a pas pu la lancer à l’heure (mise en veille ?)",
      missed_truncated: "et d’autres plus anciennes, non détaillées",
      catch_up: "rattrapage au démarrage",
      interrupted: "NOVA s’est arrêté pendant le démarrage",
      mission_missing: "mission introuvable",
      previous_run_active: "",
      daily_budget: "",
    } as Record<string, string>,
    startFailure: {
      no_key: "aucune clé de fournisseur",
      key_unreadable: "clé illisible",
      vault_unavailable: "coffre indisponible",
      provider: "le fournisseur a refusé le plan",
      conflict: "budget insuffisant ou mission refusée",
      not_found: "projet introuvable",
      invalid_request: "modèle ou contrat refusé",
      unavailable: "service indisponible",
      internal: "erreur interne",
    } as Record<string, string>,
  },

  trigger: {
    once: (when: string) => `Une fois, ${when}`,
    interval: (minutes: number): string => {
      if (minutes === 1) return "Toutes les minutes";
      if (minutes % 1440 === 0) return minutes === 1440 ? "Toutes les 24 heures" : `Tous les ${minutes / 1440} jours`;
      if (minutes % 60 === 0) return minutes === 60 ? "Toutes les heures" : `Toutes les ${minutes / 60} heures`;
      return `Toutes les ${minutes} minutes`;
    },
    daily: (time: string) => `Chaque jour à ${time}`,
    weekly: (days: string, time: string) => `Chaque ${days} à ${time}`,
    cron: (expression: string) => `Cron « ${expression} »`,
  },

  form: {
    createTitle: "Nouvelle planification",
    editTitle: "Modifier la planification",
    name: "Nom",
    goal: "Objectif de la mission",
    goalHint: "Ce que Nomi fera à chaque exécution.",
    mode: "Mode de travail",
    model: "Modèle",
    modelNone: "Aucun modèle avec outils dans le catalogue.",
    modelNoTools: "ce modèle ne sait pas appeler d’outils",
    when: "Quand",
    kinds: { once: "Une fois", interval: "Intervalle", daily: "Chaque jour", weekly: "Chaque semaine", cron: "Cron" },
    at: "Date et heure",
    every: "Toutes les (minutes)",
    time: "Heure",
    days: "Jours",
    cron: "Expression cron (5 champs)",
    cronHint: "minute heure jour-du-mois mois jour-de-semaine — par exemple */15 9-18 * * 1-5",
    timeZone: "Fuseau horaire",
    timeZoneHint: "Nom IANA, par exemple Europe/Paris. Les changements d’heure sont pris en compte.",
    preview: "Prochaines exécutions",
    previewNone: "Aucune exécution à venir avec ces réglages.",
    missed: "Si NOVA était fermé à l’heure prévue",
    policies: {
      skip: {
        label: "Ignorer les exécutions manquées",
        hint: "Elles sont notées « manquées » dans l’historique ; la suivante a lieu à l’heure prévue.",
      },
      run_once: {
        label: "Rattraper une seule fois",
        hint: "Au démarrage de NOVA, une seule exécution de rattrapage a lieu, même si plusieurs ont été manquées ; les autres sont notées « manquées ».",
      },
    } satisfies Record<MissedRunPolicy, { label: string; hint: string }>,
    contract: "Contrat de chaque exécution",
    profile: "Permissions",
    webSearch: "Recherche web permise",
    budget: "Budget par exécution (USD)",
    budgetHint: "Une exécution qui dépasserait le plafond de dépense du jour est sautée.",
    duration: "Durée maximale (minutes)",
    save: "Enregistrer",
    cancel: "Annuler",
    saveFailed: "L’enregistrement n’a pas abouti.",
    errors: {
      title: "Donne un nom (120 caractères au plus).",
      goal: "Décris l’objectif.",
      model: "Choisis un modèle.",
      at: "Choisis une date et une heure à venir.",
      every: "Au moins 1 minute, au plus 31 jours.",
      time: "Heure au format HH:MM.",
      days: "Choisis au moins un jour.",
      cron: (reason: string) => `Expression cron invalide : ${reason}.`,
      cronNever: "Cette expression ne correspond à aucune date à venir.",
      timeZone: "Fuseau horaire inconnu.",
      budget: "Un montant entre 0 et 1 000.",
      duration: "Entre 1 et 1 440 minutes.",
    },
  },

  errors: {
    not_found: "Cette planification n’existe plus.",
    conflict: "Une planification terminée ne peut pas être mise en pause ; change son déclencheur pour la relancer.",
    invalid_request: "NOVA a refusé ces réglages (déclencheur, modèle ou contrat).",
    unavailable: "Les missions planifiées sont indisponibles pour le moment.",
    other: "L’action n’a pas abouti. Réessaie.",
  },
} as const;

export function scheduleErrorCopy(code: IpcErrorCode | null): string {
  if (code === "not_found") return schedulesCopy.errors.not_found;
  if (code === "conflict") return schedulesCopy.errors.conflict;
  if (code === "invalid_request") return schedulesCopy.errors.invalid_request;
  if (code === "unavailable") return schedulesCopy.errors.unavailable;
  return schedulesCopy.errors.other;
}

// French copy of lane L5 (sub-missions). Owned by L5.
import type { IpcErrorCode, SubMissionIntegration } from "@nova/shared";

export const SUBMISSION_INTEGRATION_LABELS: Record<SubMissionIntegration, string> = {
  not_needed: "rien à intégrer",
  pending: "en attente d’intégration",
  testing: "tests en cours avant intégration",
  integrated: "intégrée",
  tests_failed: "non intégrée : les tests échouent",
  conflict: "non intégrée : conflit avec le projet",
  discarded: "abandonnée",
};

/** What each integration state means for the project, shown under the child. */
export const SUBMISSION_INTEGRATION_HINTS: Partial<Record<SubMissionIntegration, string>> = {
  pending: "Ses changements attendent dans sa copie de travail. « Intégrer » lance d’abord les tests du projet sur cette copie.",
  testing: "Les tests du projet tournent sur sa copie de travail. Rien n’est encore écrit dans le projet.",
  integrated: "Ses changements sont dans le projet, avec un point de restauration pour revenir en arrière.",
  tests_failed: "Les tests échouent sur sa copie de travail : rien n’a été écrit dans le projet.",
  conflict:
    "Des fichiers qu’elle a modifiés ont changé dans le projet depuis son départ : rien n’a été écrasé. Abandonne-la, ou réessaie après avoir remis ces fichiers en l’état.",
  discarded: "Sa copie de travail a été supprimée. Rien n’a été écrit dans le projet.",
};

export const submissionsCopy = {
  display: {
    started: (title: string) => `Sous-mission « ${title} »`,
    reserved: (amount: string) => `budget réservé : ${amount}`,
    reservedUnknown: "budget réservé : inconnu",
    worksInCopy: "travaille dans sa propre copie du projet",
  },
  tree: {
    title: (count: number) => `Sous-missions (${count})`,
    region: "Sous-missions de cette mission",
    childState: (state: string) => `mission ${state}`,
    reserved: (amount: string) => `budget réservé ${amount}`,
    reservedUnknown: "budget réservé inconnu",
    readOnly: "lecture seule",
    writes: "modifie des fichiers (copie de travail)",
    integrationRunning: "suivi de l’intégration après la fin de la sous-mission",
    open: "Ouvrir",
    openLabel: (title: string) => `Ouvrir la sous-mission « ${title} »`,
    integrate: "Intégrer",
    integrateLabel: (title: string) => `Intégrer la sous-mission « ${title} » au projet`,
    retry: "Réessayer l’intégration",
    discard: "Abandonner",
    discardLabel: (title: string) => `Abandonner la sous-mission « ${title} »`,
    discardConfirm: "Abandonner cette sous-mission ? Elle est arrêtée si elle tourne encore et sa copie de travail est supprimée.",
    parent: "Cette mission est une sous-mission : ses changements n’entrent dans le projet que par l’intégration, depuis sa mission parente.",
    openParent: "Ouvrir la mission parente",
    loading: "Chargement des sous-missions…",
    loadFailed: "Les sous-missions n’ont pas pu être chargées.",
    retryLoad: "Réessayer",
    cancel: "Annuler",
  },
  errors: {
    integrate: {
      not_found: "Cette sous-mission ou sa copie de travail n’existe plus.",
      conflict:
        "Intégration refusée : la sous-mission n’est pas terminée, ou tes règles de permission refusent un de ses fichiers ou le lancement des tests. Rien n’a été écrit.",
      unavailable:
        "Intégration impossible : aucune commande de test n’est connue pour ce projet, ou git n’a pas pu s’exécuter. Rien n’entre dans le projet sans tests verts.",
    } as Partial<Record<IpcErrorCode, string>>,
    discard: {
      not_found: "Cette sous-mission n’existe plus.",
      conflict: "Abandon impossible : elle est déjà intégrée (utilise le point de restauration) ou son intégration est en cours.",
    } as Partial<Record<IpcErrorCode, string>>,
    generic: "L’action n’a pas abouti. Réessaie ; si ça persiste, consulte les journaux (Réglages › Diagnostics).",
  },
  option: {
    label: "Sous-missions",
    description:
      "NOVA peut confier des parties indépendantes du travail à des sous-missions qui avancent en parallèle. " +
      "Chacune a un contrat jamais plus large que celui-ci et un budget réservé sur celui de cette mission. " +
      "Une sous-mission qui modifie des fichiers travaille dans sa propre copie du projet : rien n’y entre avant que tu l’intègres, après des tests verts.",
    maxChildren: "Nombre maximum de sous-missions",
    limits: (parallel: number) => `${parallel} au plus en même temps ; une sous-mission ne peut pas en lancer d’autres.`,
  },
} as const;

/** French message for a failed action, by IPC error code (never the raw developer message). */
export function submissionErrorText(action: "integrate" | "discard", code: IpcErrorCode | null): string {
  return (code !== null ? submissionsCopy.errors[action][code] : undefined) ?? submissionsCopy.errors.generic;
}

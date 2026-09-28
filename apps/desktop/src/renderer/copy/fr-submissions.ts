// French copy of lane L5 (sub-missions). Owned by L5.
import type { SubMissionIntegration } from "@nova/shared";

export const SUBMISSION_INTEGRATION_LABELS: Record<SubMissionIntegration, string> = {
  not_needed: "rien à intégrer (lecture seule)",
  pending: "en attente d’intégration",
  testing: "tests en cours avant intégration",
  integrated: "intégrée",
  tests_failed: "non intégrée : les tests échouent",
  conflict: "non intégrée : conflit avec le projet",
  discarded: "abandonnée",
};

export const submissionsCopy = {
  display: {
    started: (title: string) => `Sous-mission « ${title} »`,
    reserved: (amount: string) => `budget réservé : ${amount}`,
    reservedUnknown: "budget réservé : inconnu",
  },
} as const;

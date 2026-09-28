// French copy of lane L4 (mode « Chaîne »). Owned by L4.
import type { ChainRunState } from "@nova/shared";

export const CHAIN_STATE_LABELS: Record<ChainRunState, string> = {
  succeeded: "Programme terminé",
  failed: "Programme en échec",
  timeout: "Programme arrêté : durée maximale atteinte",
  cancelled: "Programme arrêté",
  limit: "Programme arrêté : limite d’appels atteinte",
};

export const chainCopy = {
  display: {
    calls: (count: number) => `${count} appel${count > 1 ? "s" : ""} d’outil`,
    result: "Résultat du programme",
  },
} as const;

// French copy of lane L4 (mode « Chaîne »). Owned by L4.
import type { ChainRunState } from "@nova/shared";

export const CHAIN_STATE_LABELS: Record<ChainRunState, string> = {
  succeeded: "Programme terminé",
  failed: "Programme en échec",
  timeout: "Programme arrêté : durée maximale atteinte",
  cancelled: "Programme arrêté",
  limit: "Programme arrêté : limite atteinte",
};

function seconds(ms: number): string {
  if (ms < 1_000) return "moins d’une seconde";
  const value = Math.round(ms / 100) / 10;
  return `${value.toLocaleString("fr-FR")} s`;
}

export const chainCopy = {
  display: {
    calls: (count: number) => `${count} appel${count > 1 ? "s" : ""} d’outil`,
    duration: (ms: number) => seconds(ms),
    result: "Résultat du programme",
    noResult: "Le programme n’a rien renvoyé.",
    stoppedCallsNote: "Les appels faits avant l’arrêt ont eu lieu : leurs cartes sont ci-dessous.",
  },
  timeline: {
    program: "Programme",
    programUnknown: "Programme : inconnu (début absent du journal)",
    children: (count: number) => `${count} appel${count > 1 ? "s" : ""} de ce programme`,
    noChildren: "Aucun appel d’outil.",
  },
  option: {
    label: "Mode « Chaîne »",
    description:
      "NOVA peut écrire un petit programme qui enchaîne plusieurs outils en une seule étape (lire des fichiers, trier, puis agir). " +
      "Chaque appel du programme reste soumis à tes règles et à tes approbations, et apparaît sous la carte du programme.",
    limits: (calls: number, minutes: number) =>
      `Limites : ${calls} appels d’outil et ${minutes} min par programme ; aucun accès au réseau ni au disque en dehors des outils.`,
  },
} as const;

// French copy of lane L2 (context gauge, summaries, handoff dossier, model switch). Owned by L2.
import type { CompactionStatus, ContextUsage } from "@nova/shared";

export const CONTEXT_SOURCE_LABELS: Record<ContextUsage["source"], string> = {
  provider_usage: "mesuré par le fournisseur",
  estimate: "estimation",
  unknown: "inconnu",
};

export const SUMMARY_STATUS_LABELS: Record<CompactionStatus, string> = {
  proposed: "Résumé proposé",
  applied: "Résumé appliqué",
  dismissed: "Résumé écarté",
};

export const contextCopy = {
  gauge: {
    label: "Contexte utilisé",
    percent: (value: string) => `${value} %`,
    tokens: (used: string, total: string) => `≈ ${used} sur ${total} jetons`,
    tokensNoTotal: (used: string) => `≈ ${used} jetons`,
    unknown: "inconnu",
    unknownLength: "Taille du contexte de ce modèle inconnue : NOVA ne proposera pas de résumé automatiquement.",
    due: "Le contexte approche de sa limite. Un résumé remplacerait l’historique ancien, après ton accord.",
    compact: "Résumer maintenant",
    compacting: "Résumé en cours…",
  },
  summary: {
    writtenBy: (model: string) => `Écrit par ${model}`,
    writtenByNova: "Rédigé par NOVA à partir de son journal",
    writtenByUnknown: "Auteur inconnu",
    notModelSpeech: "Ceci est un résumé, pas une réponse du modèle.",
    willReplace: "Appliqué, il remplace l’historique qu’il couvre dans ce qui est envoyé au modèle. L’historique enregistré ne change pas.",
    replaced: "Il remplace l’historique qu’il couvre dans ce qui est envoyé au modèle. L’historique enregistré n’a pas changé.",
    tokens: (before: string, after: string) => `Contexte : ${before} → ≈ ${after} jetons`,
    cost: (value: string) => `Coût du résumé : ${value}`,
    costUnknown: "Coût du résumé : inconnu",
    pruned: "Sorties d’outils raccourcies pour écrire le résumé (début et fin gardés) :",
    prunedItem: (tool: string, before: string, after: string) => `${tool} : ${before} → ${after} caractères`,
    apply: "Appliquer",
    dismiss: "Écarter",
    applyFailed: "Le résumé n’a pas pu être appliqué",
    dismissFailed: "Le résumé n’a pas pu être écarté",
    compactFailed: "Le résumé n’a pas pu être écrit",
    expired: "Non appliqué : la mission s’est terminée avant ta décision.",
    manual: "Demandé par toi",
    automatic: "Proposé par NOVA",
  },
  handoff: {
    title: (from: string, to: string) => `Dossier de passation : ${from} → ${to}`,
    goal: "Objectif",
    done: "Fait (vérifié par NOVA)",
    remaining: "Reste à faire",
    decisions: "Décisions",
    files: "Fichiers modifiés",
    questions: "Questions ouvertes",
    empty: "rien",
    switched: (from: string, to: string) => `Modèle changé : ${from} → ${to}. Il reprend depuis le dossier de passation.`,
    pending: "Le nouveau modèle prendra la suite au prochain appel.",
  },
  switcher: {
    open: "Changer de modèle",
    label: "Nouveau modèle",
    explain:
      "NOVA prépare un dossier de passation à partir de son journal (objectif, étapes, décisions, fichiers). Le nouveau modèle reprend depuis ce dossier au prochain appel ; il ne reçoit aucun état interne de l’ancien.",
    confirm: "Changer",
    cancel: "Annuler",
    none: "Aucun autre modèle du catalogue n’accepte les outils.",
    failed: "Le modèle n’a pas pu être changé",
    done: (model: string) => `Dossier prêt : ${model} prend la suite au prochain appel.`,
  },
  conversation: {
    heading: "Contexte de la conversation",
    proposalReady: "Résumé prêt : relis-le puis applique-le ou écarte-le.",
  },
  command: {
    /** Palette entry and its hint (« /compact » in the composer does the same). */
    palette: "Résumer la conversation",
    paletteHint: "Propose un résumé de l’historique, appliqué seulement après ton accord",
    tooLong: (max: number) => `Consigne trop longue : ${max} caractères au plus. Rien n’a été envoyé.`,
    needsConversation: "Rien à résumer : cette conversation n’a pas encore de message.",
    needsModel: "Choisis d’abord un modèle : c’est lui qui écrit le résumé.",
  },
} as const;

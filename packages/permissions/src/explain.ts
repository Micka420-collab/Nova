// French explanation of a decision, shown on the approval card and in the audit viewer ("which rule
// asked and why"). Built from facts the engine already has; never from model-provided text.
import type { OperationClass, PermissionDecisionKind, PermissionProfile, PermissionReason, WorkMode } from "@nova/shared";

export interface ExplanationFacts {
  decision: PermissionDecisionKind;
  reason: PermissionReason;
  operation: OperationClass;
  path: string | null;
  host: string | null;
  mode: WorkMode | null;
  profile: PermissionProfile;
  /** Risk label of the command (commands.ts), if any. */
  commandLabel: string | null;
}

export const OPERATION_LABELS: Readonly<Record<OperationClass, string>> = {
  read: "lire des fichiers",
  write: "modifier des fichiers",
  delete: "supprimer des fichiers",
  execute: "lancer une commande",
  network: "accéder à Internet",
  git_mutation: "modifier le dépôt Git",
  external: "agir hors de NOVA",
};

export const MODE_LABELS: Readonly<Record<WorkMode, string>> = {
  discuss: "Discuter",
  understand: "Comprendre",
  plan: "Planifier",
  build: "Construire",
  fix: "Corriger",
  verify: "Vérifier",
};

export const PROFILE_LABELS: Readonly<Record<PermissionProfile, string>> = {
  read_only: "Lecture seule",
  assisted: "Assisté",
  autonomous: "Autonome dans ce projet",
  custom: "Personnalisé",
};

function target(facts: ExplanationFacts): string {
  if (facts.path) return ` (${facts.path})`;
  if (facts.host) return ` (${facts.host})`;
  return "";
}

export function explainDecision(facts: ExplanationFacts): string {
  const action = OPERATION_LABELS[facts.operation];
  const profile = PROFILE_LABELS[facts.profile];
  switch (facts.reason) {
    case "outside_workspace":
      return "Ce chemin est hors du projet : NOVA n'y touche pas.";
    case "excluded_path":
      return `Fichier sensible exclu${target(facts)} : secrets et clés ne sont jamais lus ni modifiés par l'agent.`;
    case "dangerous_command":
      return `Commande interdite : elle ${facts.commandLabel ?? "présente un risque grave"}. Rien n'a été fait.`;
    case "isolation_unavailable":
      return "Cette action exige une isolation plus forte que celle disponible sur cette machine.";
    case "mode_forbids":
      return facts.mode
        ? `Le mode ${MODE_LABELS[facts.mode]} ne permet pas de ${action}.`
        : `Ce mode ne permet pas de ${action}.`;
    case "contract_forbids":
      return `Le contrat de la mission ne prévoit pas de ${action}${target(facts)}. Rien n'a été fait.`;
    case "contract_allows":
      return `Prévu par le contrat de la mission : ${action}${target(facts)}.`;
    case "always_ask":
      if (facts.commandLabel) return `Cette commande ${facts.commandLabel} : confirmation demandée à chaque fois.`;
      if (facts.operation === "external") return "Cette action ne pourra pas être annulée par NOVA : confirmation demandée à chaque fois.";
      return `Action sensible${target(facts)} : confirmation demandée à chaque fois.`;
    case "tainted_context":
      return "Du contenu non fiable (page, fichier ou outil externe) a été lu : les accès vers l'extérieur demandent ta confirmation.";
    case "remembered_approval":
      return `Déjà autorisé par toi : ${action}${target(facts)}.`;
    case "profile_allows":
      return `Autorisé par le profil ${profile} : ${action}${target(facts)}.`;
    case "profile_asks":
      return `Le profil ${profile} demande ta confirmation pour ${action}${target(facts)}.`;
    case "profile_forbids":
      return `Refusé par tes réglages de permissions : ${action}${target(facts)}.`;
    case "domain_policy":
      return facts.decision === "deny"
        ? `Adresse refusée par ta politique réseau${target(facts)}.`
        : `Adresse hors du contrat${target(facts)} : confirmation demandée.`;
    case "mcp_tool_policy":
      return facts.decision === "deny"
        ? "Cet outil de service connecté est désactivé dans tes réglages."
        : "Cet outil de service connecté demande ta confirmation.";
    case "default_ask":
      return `Aucune règle ne couvre cette action : confirmation demandée pour ${action}${target(facts)}.`;
  }
}

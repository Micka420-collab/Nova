// French copy of the atelier settings sections (Budget, Permissions, Internet, Audit). Merged into `fr.atelierSettings`.
import type { ApprovalStatus, WebPolicyPreset, WebRuleAction } from "@nova/shared";

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

export const WEB_ACTION_LABELS: Record<WebRuleAction, string> = {
  allow: "Autoriser",
  ask: "Demander",
  deny: "Refuser",
};

export const WEB_PRESET_COPY: Record<WebPolicyPreset, { label: string; hint: string }> = {
  dev_docs: {
    label: "Documentation de développement",
    hint: "Autorise les sites de documentation et les dépôts de paquets courants, demande pour le reste.",
  },
  no_internet: { label: "Aucun accès Internet", hint: "Refuse tout accès, sauf le fournisseur du modèle." },
  ask_everything: { label: "Toujours demander", hint: "Chaque nouvelle adresse demande ta confirmation." },
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "en attente",
  approved: "autorisée",
  denied: "refusée",
  expired: "expirée",
};

export const atelierSettingsCopy = {
  common: {
    retry: "Réessayer",
    save: "Enregistrer",
    saved: "Réglage enregistré",
    saveFailed: "Le réglage n'a pas été enregistré",
    loadFailed: "Ces informations n'ont pas pu être lues",
    noWorkspace: "Aucun dossier ouvert",
    cancel: "Annuler",
  },
  budget: {
    defaultsTitle: "Plafonds par défaut",
    perMission: "Plafond par mission",
    perMissionHint: "modifiable dans chaque contrat, avant le lancement",
    perDay: "Plafond par jour",
    duration: "Durée maximale d'une mission",
    minutes: (count: number) => plural(count, "minute", "minutes"),
    whereToChange:
      "Le plafond d'une mission se règle dans son contrat, juste avant « Lancer la mission ». Au plafond, la mission est suspendue : elle ne reprend jamais seule.",
    todayTitle: "Aujourd'hui",
    todayNone: "Rien de consommé pour l'instant.",
    todayUnknown: "Consommation du jour inconnue : aucune mission n'a encore rapporté son budget dans cette session.",
    amountsTitle: "Trois montants, toujours nommés",
    amounts: [
      "Estimé : la fourchette annoncée avant le lancement, avec ses hypothèses.",
      "Réservé : ce qui est bloqué avant chaque appel pour ne jamais dépasser le plafond.",
      "Constaté : ce que le fournisseur a réellement rapporté.",
    ],
    billingNote:
      "Le fournisseur facture parfois avec retard : le montant final chez OpenRouter peut différer légèrement. Ce qui est affiché est ce que le fournisseur a rapporté.",
    reportTitle: "Coût par mission",
    reportNoWorkspace: "Ouvre un dossier pour voir le coût de ses missions.",
    reportEmpty: "Aucune mission pour ce projet.",
    reportLoading: "Lecture des missions…",
    colMission: "Mission",
    colState: "État",
    colCost: "Coût constaté",
    costLoading: "lecture…",
    atLeast: (cost: string, count: number) =>
      `au moins ${cost} (${plural(count, "appel sans coût rapporté", "appels sans coût rapporté")})`,
    copyCsv: "Copier en CSV",
    copied: "Copié",
    copyFailed: "Copie impossible",
    csvHeader: ["mission", "etat", "cout_constate_usd", "appels_sans_cout", "cree_le"],
    shown: (count: number) => `${plural(count, "mission la plus récente", "missions les plus récentes")}`,
  },
  permissions: {
    noWorkspaceBody: "Ouvre un dossier pour régler ses permissions.",
    profileLegend: "Profil de permissions de ce projet",
    isolation: "Isolation disponible",
    isolationLevels: {
      L0: "Processus séparé, sans isolation du système de fichiers.",
      L1: "Bac à sable du système : fichiers et réseau restreints.",
      L2: "Conteneur.",
    },
    autonomousBanner:
      "Autonome sans isolation : les commandes tournent dans un processus séparé, mais peuvent lire tes autres fichiers. Les suppressions massives, envois et paiements demandent toujours ta confirmation.",
    rememberedTitle: "Autorisations mémorisées",
    rememberedIntro: "Ce que tu as autorisé « pour cette mission » ou « pour ce projet ».",
    rememberedEmpty: "Aucune autorisation mémorisée pour ce projet.",
    colTool: "Outil",
    colOperation: "Opération",
    colTarget: "Cible",
    colScope: "Portée",
    colDate: "Date",
    colActions: "Actions",
    anyTool: "Tous les outils",
    anyTarget: "Partout dans le projet",
    revoke: "Révoquer",
    revokeAll: "Tout révoquer",
    revokeAllConfirm: (count: number) =>
      count === 1 ? "Révoquer l'autorisation mémorisée ? NOVA te redemandera." : `Révoquer les ${count} autorisations mémorisées ? NOVA te redemandera.`,
    revoked: (count: number) => (count === 1 ? "1 autorisation révoquée" : `${count} autorisations révoquées`),
    sensitiveTitle: "Fichiers que l'agent ne lit jamais",
    sensitiveIntro:
      "Ces fichiers ne sont jamais lus, modifiés ni envoyés par l'agent, quel que soit le profil. Tu peux en ajouter dans un fichier .novaignore à la racine du projet. Tu peux toujours les ouvrir toi-même dans l'éditeur.",
    sensitiveAllowed: "exception, lisible",
    unchanged: "Aucun changement à enregistrer.",
  },
  internet: {
    scopeLabel: "Portée",
    scopeGlobal: "Tous les projets",
    scopeWorkspace: (name: string) => `Ce projet (${name})`,
    defaultAction: "Pour une adresse sans règle",
    presetsTitle: "Préréglages",
    presetApplied: (label: string) => `Préréglage appliqué : ${label}`,
    presetHint: "Un préréglage remplace les règles qu'il avait créées ; tes propres règles sont gardées.",
    rulesTitle: "Règles",
    rulesEmpty: "Aucune règle : l'action par défaut s'applique à toutes les adresses.",
    pattern: (index: number) => `Adresse de la règle ${index}`,
    action: (index: number) => `Action de la règle ${index}`,
    remove: (index: number) => `Retirer la règle ${index}`,
    fromPreset: "préréglage",
    add: "Ajouter une règle",
    invalid: (value: string) => `« ${value} » n'est pas une adresse valide (exemple.com ou *.exemple.com, sans http://).`,
    empty: "Adresse vide.",
    always:
      "Les adresses privées, locales et de métadonnées cloud sont toujours refusées, quelles que soient ces règles. Le contrat d'une mission peut restreindre cette politique, jamais l'élargir.",
  },
  audit: {
    title: "Journal d'audit",
    intro:
      "Ce que l'agent a été autorisé, refusé ou appelé à te demander, et ce qu'il a fait : fichiers, commandes, sites, octets envoyés, coût. Le journal ne contient jamais le contenu des fichiers ni des pages ; il est gardé 90 jours.",
    empty: "Rien n'est encore enregistré.",
    filteredEmpty: "Aucune entrée ne correspond à ces filtres.",
    filterPeriod: "Période",
    filterActor: "Qui",
    filterDecision: "Décision",
    filterOperation: "Opération",
    filterText: "Rechercher (outil, fichier, adresse, commande)",
    all: "Tout",
    periods: { day: "Dernières 24 h", week: "7 derniers jours", month: "30 derniers jours" },
    actors: { agent: "Agent", user: "Toi", system: "NOVA" },
    decisions: { allow: "Autorisé", ask: "Demandé", deny: "Refusé" },
    actions: {
      "permission.decision": "Décision",
      "approval.requested": "Demande d'accord",
      "approval.decided": "Réponse",
      "approval.expired": "Demande expirée",
      "tool.executed": "Exécution",
      "permissions.profile_changed": "Profil modifié",
      "permissions.rules_revoked": "Autorisations révoquées",
    },
    count: (shown: number, total: number) => `${shown} sur ${total}`,
    loadMore: "Afficher les entrées plus anciennes",
    colTime: "Heure",
    colActor: "Qui",
    colAction: "Action",
    colTarget: "Cible",
    colStatus: "Décision",
    colDetails: "Détails",
    colCost: "Coût",
    bytesSent: (value: string) => `${value} o envoyés`,
    bytesReceived: (value: string) => `${value} o reçus`,
    bytesWritten: (value: string) => `${value} o écrits`,
    exitCode: (code: number) => `code ${code}`,
    duration: (ms: string) => `${ms} ms`,
  },
} as const;

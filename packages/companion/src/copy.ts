// Nomi's French copy (NOMI.md §4, warm tone, "tu"). One fact per bubble, at most two actions,
// no exclamation mark, no guilt, no flattery, never "Tests réussis" before a real exit code 0.
// Every string here is checked by the anti-manipulation test (manipulation.test.ts, N11).
import type { MissionFailureReason, MissionSuspendReason, ProviderErrorCode, ToolErrorCode } from "@nova/shared";
import { formatClock, formatUsd, plural } from "./format";

const mission = (title: string | null): string => (title ? `« ${title} »` : "La mission");

export const NOMI_COPY = {
  state: {
    waitingApproval: "Nomi attend ta réponse",
    approvalsPending: (count: number) =>
      count <= 1 ? "1 approbation en attente" : `${count} approbations en attente`,
    missionWorking: "Nomi travaille",
    missionDone: "Mission terminée",
    missionFailed: "La mission a échoué",
    missionStopped: "Mission arrêtée",
    suspendedBudget: "Mission suspendue : plafond atteint",
    suspended: "Mission suspendue",
    missionStep: (title: string | null, step: number | null, steps: number | null) => {
      const name = title ?? "Mission";
      return step !== null && steps !== null ? `${name}, étape ${step}/${steps}` : name;
    },
    quiet: (until: number) => `Nomi est en mode discret jusqu'à ${formatClock(until)}`,
  },

  menu: {
    label: "Actions de Nomi",
    stopMission: "Arrêter la mission",
    resumeMission: "Reprendre la mission",
    openApproval: "Répondre à l'approbation",
    explainError: "Explique cette erreur",
    showChanges: "Qu'est-ce qui a changé ?",
    watchCommand: "Surveille la commande en cours",
    retry: "Réessayer",
    quietOn: "Mode discret pendant 1 h",
    quietOff: "Quitter le mode discret",
    settings: "Réglages du compagnon",
    group: "Nomi",
  },

  suggestion: {
    connectionAbsent: "Ajoute une clé OpenRouter pour commencer.",
    approval: (summary: string) => `Une mission attend ta réponse : ${summary}.`,
    budget: (title: string | null, spent: number | null, cap: number | null) =>
      spent !== null && cap !== null
        ? `${mission(title)} est suspendue au plafond (${formatUsd(spent)} sur ${formatUsd(cap)}). Tu peux l'arrêter ou relever le plafond depuis sa carte.`
        : `${mission(title)} est suspendue au plafond. Tu peux l'arrêter ou relever le plafond depuis sa carte.`,
    testFailed: (what: string, at: number) => `${what} échoue depuis ${formatClock(at)}.`,
    processCrashed: (command: string, code: number | null) =>
      code === null ? `La commande ${command} s'est arrêtée.` : `La commande ${command} s'est arrêtée (code ${code}).`,
    missionFailed: (title: string | null, reason: string) => `${mission(title)} a échoué : ${reason}.`,
    missionDone: (title: string | null, files: number) =>
      files > 0
        ? `${mission(title)} est terminée : ${plural(files, "fichier modifié", "fichiers modifiés")} attendent ta décision.`
        : `${mission(title)} est terminée.`,
    missionWaiting: (title: string | null, reason: string) => `${mission(title)} est en pause : ${reason}.`,
    chatFailed: (reason: string) => `La dernière réponse a échoué (${reason}).`,
    chatTruncated: "Réponse coupée à sa longueur maximale.",
    addKey: "Ajouter une clé",
    otherModel: "Autre modèle",
    openConversation: "Voir la conversation",
    look: "Regarde",
    later: "Plus tard",
    muteKind: "Ignore ce type de signal",
    evidence: "Preuve",
  },

  bubble: {
    close: "Fermer",
    open: "Ouvrir",
    region: "Messages de Nomi",
  },

  actionLabel: {
    start_mission: "Lancer la mission",
    stop_mission: "Arrêter la mission",
    open_approval: "Voir l'approbation",
    explain_error: "Explique cette erreur",
    show_changes: "Voir les changements",
    open_diff: "Voir le diff",
    watch_command: "Surveiller la commande",
  },

  outcome: {
    missionStopped: (title: string | null) => `${mission(title)} est arrêtée.`,
    nothingToStop: "Rien à arrêter : la mission était déjà terminée.",
    missionStarted: (title: string | null) => `${mission(title)} est lancée.`,
    missionResumed: (title: string | null) => `${mission(title)} reprend.`,
    approvalOpened: "Carte d'approbation ouverte.",
    noApproval: "Aucune approbation en attente.",
    changesOpened: "Changements affichés.",
    outputOpened: "Sortie de la commande affichée dans le terminal.",
    noChanges: "Aucun changement enregistré pour cette mission.",
    watching: (command: string) => `Je surveille ${command}. Je te dis quand elle se termine.`,
    alreadyWatching: "Cette commande est déjà surveillée.",
    nothingToWatch: "Aucune commande en cours à surveiller.",
    quietOn: (until: number) => `Mode discret jusqu'à ${formatClock(until)} : seules les approbations passent.`,
    quietOff: "Mode discret terminé.",
    snoozed: "D'accord, je la garde pour plus tard.",
    dismissed: "Suggestion écartée.",
    muted: "Je ne proposerai plus ce type de signal. Tu peux le réactiver dans les réglages du compagnon.",
    failed: (reason: string) => `L'action n'a pas abouti : ${reason}`,
    unavailable: "Cette action n'est pas encore disponible dans cette version.",
    notFound: "Cet élément n'existe plus.",
    unknownError: "erreur inconnue",
    askedModel: (model: string) => `Question envoyée à ${model} : la réponse arrive dans une nouvelle conversation.`,
    attached: (name: string) => `${name} est ajouté au message en cours. Relis-le, puis envoie quand tu veux.`,
  },

  explain: {
    heading: "Explication tirée des faits enregistrés, sans appel au modèle.",
    title: "Ce qui s'est passé",
    why: "Pourquoi",
    next: "Quoi faire",
    askModel: "Demander au modèle",
    askModelDisclosure: (chars: number, model: string) =>
      `Cette action enverra l'erreur et ${plural(chars, "caractère")} de contexte à ${model}.`,
    cost: (min: number, max: number) =>
      max < 0.01
        ? "Coût estimé : moins de 0,01 $"
        : min === max
          ? `Coût estimé : ${formatUsd(min)}`
          : `Coût estimé : entre ${formatUsd(min)} et ${formatUsd(max)}`,
    costUnknown: "Coût estimé : inconnu (prix du modèle non publié)",
    unknown: "inconnu",
    command: (command: string, code: number | null, signal: string | null) =>
      code !== null
        ? `La commande ${command} s'est terminée avec le code ${code}.`
        : signal
          ? `La commande ${command} a été interrompue (${signal}).`
          : `La commande ${command} s'est arrêtée sans code de sortie.`,
    commandNext: "Lis la fin de la sortie ci-dessous, puis relance ou demande une correction.",
    tests: (failed: number | null, passed: number | null) =>
      failed !== null && passed !== null
        ? `Tests : ${plural(passed, "réussi")}, ${plural(failed, "échoué")}.`
        : "Les tests ont échoué ; le compte exact est inconnu.",
    testsNext: "Ouvre la sortie du test pour voir l'assertion qui échoue, ou lance une mission Corriger.",
    missionFailedNext: "Relis les preuves de la mission, puis relance-la ou change de modèle.",
    missionSuspendedNext: "Relève le plafond depuis la carte de mission, ou arrête-la.",
  },

  toolError: {
    invalid_arguments: { what: "L'outil a reçu des arguments invalides.", why: "Le modèle a produit une demande mal formée." },
    permission_denied: { what: "L'action a été refusée.", why: "Les permissions du projet ne l'autorisent pas." },
    not_found: { what: "Le fichier ou l'élément demandé n'existe pas.", why: null },
    conflict: {
      what: "Le fichier a changé pendant l'opération.",
      why: "Une autre modification est passée entre la lecture et l'écriture ; rien n'a été écrasé.",
    },
    outside_workspace: { what: "Le chemin est hors de l'espace de travail.", why: "NOVA n'agit que dans le dossier ouvert." },
    excluded_path: { what: "Ce chemin est exclu.", why: "Il fait partie des fichiers protégés (secrets, dépendances…)." },
    too_large: { what: "Le contenu est trop volumineux.", why: "Il dépasse la limite fixée pour un outil." },
    timeout: { what: "L'opération a dépassé son délai.", why: null },
    cancelled: { what: "L'opération a été annulée.", why: null },
    unavailable: { what: "L'outil n'est pas disponible pour le moment.", why: null },
    failed: { what: "L'outil a échoué.", why: null },
  } satisfies Record<ToolErrorCode, { what: string; why: string | null }>,

  missionFailure: {
    acceptance_failed: "les critères d'acceptation ne sont pas remplis",
    provider_error: "le fournisseur a renvoyé une erreur",
    no_tool_support: "ce modèle ne sait pas utiliser d'outils",
    iteration_limit: "la limite d'itérations est atteinte",
    internal: "erreur interne",
  } satisfies Record<MissionFailureReason, string>,

  /** Short reason of a failed answer, for a notification or a suggestion (title + fact only). */
  chatFailure: {
    no_key: "aucune clé",
    invalid_key: "clé refusée",
    insufficient_credits: "crédit épuisé",
    forbidden: "accès refusé par le fournisseur",
    rate_limited: "trop de requêtes",
    timeout: "délai dépassé",
    not_found: "modèle introuvable",
    model_unavailable: "modèle indisponible",
    no_provider: "aucun fournisseur disponible",
    bad_request: "requête refusée",
    network: "réseau indisponible",
    stream_interrupted: "réponse interrompue",
    provider_error: "erreur du fournisseur",
    aborted: "arrêtée",
    truncated: "réponse coupée à sa longueur maximale",
    filtered: "réponse filtrée par le fournisseur",
    empty_response: "réponse vide",
    key_unreadable: "clé illisible",
    unknown: "erreur inconnue",
  } satisfies Record<ProviderErrorCode, string>,

  suspendReason: {
    budget: "plafond de budget atteint",
    daily_budget: "budget du jour atteint",
    duration: "durée maximale atteinte",
    no_progress: "Nomi n'avance plus",
    user: "suspendue à ta demande",
  } satisfies Record<MissionSuspendReason, string>,

  watch: {
    started: (command: string) => `Surveillance de ${command}`,
    testsDone: (passed: number, failed: number, firstFailure: string | null) => {
      const counts = `${plural(passed, "réussi")}, ${plural(failed, "échoué")}`;
      return firstFailure ? `Tests terminés : ${counts} (${firstFailure}).` : `Tests terminés : ${counts}.`;
    },
    commandDone: (code: number | null) =>
      code === null ? "Commande terminée, code inconnu." : `Commande terminée, code ${code}.`,
    interrupted: (signal: string) => `Commande interrompue (${signal}).`,
  },

  changes: {
    files: (count: number, additions: number, deletions: number) =>
      `${plural(count, "fichier modifié", "fichiers modifiés")} (+${additions} / −${deletions})`,
    noFiles: "Aucun fichier modifié",
    tests: (runs: number, passed: number | null, failed: number | null) =>
      passed !== null && failed !== null
        ? `${plural(runs, "lancement de tests", "lancements de tests")} : ${plural(passed, "réussi")}, ${plural(failed, "échoué")} au dernier`
        : `${plural(runs, "lancement de tests", "lancements de tests")}, résultat du dernier inconnu`,
    noTests: "Aucun test lancé",
    commands: (count: number, failed: number) =>
      failed > 0
        ? `${plural(count, "commande lancée", "commandes lancées")}, ${failed} en échec`
        : plural(count, "commande lancée", "commandes lancées"),
    checkpoint: (count: number, last: number | null) =>
      last === null ? plural(count, "point de reprise") : `${plural(count, "point de reprise")}, le dernier à ${formatClock(last)}`,
    conversation: (messages: number, models: number, cost: string) =>
      `${plural(messages, "message")}, ${plural(models, "modèle utilisé", "modèles utilisés")}, ${cost}`,
    costUnknown: "coût inconnu",
  },

  notify: {
    approval: (title: string | null, summary: string) => `${mission(title)} attend ta réponse : ${summary}.`,
    approvals: (count: number) => `${count} approbations en attente.`,
    succeeded: (title: string | null) => `${mission(title)} est terminée.`,
    failed: (title: string | null, reason: string) => `${mission(title)} a échoué : ${reason}.`,
    suspended: (title: string | null, reason: string) => `${mission(title)} est suspendue : ${reason}.`,
    grouped: (count: number) => `${count} nouvelles notices de mission.`,
    chatFailed: (title: string, reason: string) => `« ${title} » a échoué : ${reason}.`,
  },

  drop: {
    attach: "Joindre à la conversation",
    attachDisclosure: (size: string) => `Cette action enverra ${size} au fournisseur choisi.`,
    imageUnsupported: "Ce modèle ne lit pas les images",
    chooseModel: "Choisir un modèle compatible",
    openWorkspace: "Ouvrir un espace de travail",
    unsupported: "Ce type de fichier ne peut pas être joint.",
    imageNotYet: "L'envoi d'images n'est pas encore pris en charge : seuls les fichiers texte peuvent être joints.",
    tooLarge: (max: string) => `Fichier trop volumineux (maximum ${max}).`,
    hint: "Dépose un fichier sur Nomi",
    cancel: "Annuler",
  },
} as const;

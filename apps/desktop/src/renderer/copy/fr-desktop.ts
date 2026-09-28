// French copy of lane L7 (onboarding, mission density, background option, chat autopilot, pasted
// images). Owned by L7.
import type { DesktopState, DetailDensity, OnboardingProfile, ReasoningEffort } from "@nova/shared";
import type { ImageRejection } from "../lib/vision";

const plural = (count: number, one: string, many: string): string => `${count} ${count > 1 ? many : one}`;

/** One count of the activity line, or « inconnu » when main could not read its source. */
function activityPart(known: boolean, count: number, one: string, many: string): string {
  return known ? plural(count, one, many) : `${many} : inconnu`;
}

export const DENSITY_LABELS: Record<DetailDensity, string> = {
  result: "Résultat",
  key_steps: "Étapes clés",
  all: "Tout",
};

export const DENSITY_DESCRIPTIONS: Record<DetailDensity, string> = {
  result: "La réponse finale et les preuves. Les décisions à prendre restent toujours visibles.",
  key_steps: "Les modifications, commandes, tests et décisions ; les lectures de routine sont masquées.",
  all: "Chaque lecture, recherche et appel d'outil, dans l'ordre.",
};

export const PROFILE_LABELS: Record<OnboardingProfile, string> = {
  code: "Code et développement",
  documents: "Documents et création",
};

export const PROFILE_DESCRIPTIONS: Record<OnboardingProfile, string> = {
  code: "Des projets de code : Nomi lit, modifie, lance les tests. Les étapes clés sont proposées par défaut.",
  documents: "Des textes, notes et fichiers : l'essentiel d'abord. Le résultat seul est proposé par défaut.",
};

/** The density proposed with each profile (the user can pick another one right away). */
export const PROFILE_DEFAULT_DENSITY: Record<OnboardingProfile, DetailDensity> = {
  code: "key_steps",
  documents: "result",
};

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: "Faible",
  medium: "Moyen",
  high: "Élevé",
};

export const IMAGE_REJECTIONS: Record<ImageRejection, (name: string | null) => string> = {
  type: (name) => `${name ?? "Ce fichier"} n'est pas une image PNG, JPEG, WebP ou GIF.`,
  size: (name) => `${name ?? "Cette image"} est trop lourde (6 Mo au plus).`,
  count: () => "4 images au plus par message.",
  read: (name) => `${name ?? "Cette image"} n'a pas pu être lue.`,
};

export const desktopCopy = {
  onboarding: {
    title: "Comment vas-tu utiliser NOVA ?",
    intro: "Deux choix rapides pour adapter l'affichage. Ils ne changent pas ce que Nomi a le droit de faire, et tu pourras les modifier dans les réglages.",
    profileLegend: "Ton usage principal",
    densityLegend: "Détail affiché dans les missions",
    submit: "Commencer",
    later: "Plus tard",
    saving: "Enregistrement…",
    needProfile: "Choisis ton usage principal pour continuer.",
    failed: "Tes choix n'ont pas pu être enregistrés.",
  },
  density: {
    legend: "Détail affiché",
    hidden: (count: number, level: string) => `${plural(count, "étape masquée", "étapes masquées")} (niveau « ${level} »)`,
    showAll: "Tout afficher",
    failed: "Le niveau de détail n'a pas pu être enregistré.",
  },
  settings: {
    title: "Bureau et affichage",
    backgroundTitle: "Arrière-plan",
    keepRunning: "Continuer en arrière-plan quand la fenêtre est fermée",
    keepRunningHelp:
      "Les missions, terminaux et plannings continuent après la fermeture de la fenêtre. Nomi reste dans la barre système : clique dessus pour rouvrir NOVA ou pour quitter. Désactivé, fermer la fenêtre quitte NOVA.",
    noTray:
      "La barre système n'est pas disponible sur ce bureau : fermer la fenêtre la réduira au lieu de la masquer.",
    quitNote: "Avant de quitter, NOVA te prévient si une mission, un terminal, un processus ou un planning est actif.",
    activity: ({ activity, unreadable }: DesktopState): string => {
      const known = (source: DesktopState["unreadable"][number]) => !unreadable.includes(source);
      const parts = [
        activityPart(known("missions"), activity.runningMissions, "mission en cours", "missions en cours"),
        activityPart(known("approvals"), activity.waitingApprovals, "approbation en attente", "approbations en attente"),
        activityPart(known("terminals"), activity.runningTerminals, "terminal ouvert", "terminaux ouverts"),
        activityPart(known("processes"), activity.runningProcesses, "processus en arrière-plan", "processus en arrière-plan"),
        activityPart(known("schedules"), activity.activeSchedules, "planning actif", "plannings actifs"),
      ];
      const note = unreadable.length > 0 ? " NOVA n'a pas pu tout vérifier." : "";
      return `En ce moment : ${parts.join(", ")}.${note}`;
    },
    densityTitle: "Missions",
    chatTitle: "Discuter",
    autopilot: "Pilote automatique",
    autopilotHelp:
      "Avant chaque message, un petit modèle du catalogue estime l'effort de réflexion utile et si la recherche web aide. Le choix s'affiche avant l'envoi et tu peux le changer. Chaque estimation est un appel facturé : son coût s'affiche avec le choix.",
    suggestVision: "Proposer un modèle qui lit les images quand j'en colle une",
    suggestVisionHelp: "Le modèle proposé vient du catalogue OpenRouter ; rien ne change sans ton clic.",
    failed: "Le réglage n'a pas pu être enregistré.",
  },
  autopilot: {
    hint: "Pilote automatique : Entrée prépare les réglages, Entrée à nouveau envoie",
    classifying: "Analyse du message…",
    title: "Réglages proposés pour ce message",
    fallbackTitle: "Réglages par défaut",
    staleTitle: "Message modifié depuis l'estimation",
    staleText: "Les réglages proposés concernaient un autre texte ou d'autres images. Entrée les réestime pour ce message.",
    effort: "Effort de réflexion",
    effortNotApplicable: "non réglable pour ce modèle",
    web: "Recherche web",
    by: (model: string) => `Estimé par ${model}`,
    cost: (value: string) => `coût ${value}`,
    costUnknown: "coût inconnu",
    send: "Envoyer avec ces réglages",
    reclassify: "Réestimer",
    dismiss: "Écarter",
    failed: "Le pilote automatique n'a pas répondu. Réessaie, ou envoie sans lui.",
    unavailable: "Le pilote automatique n'est pas disponible. Appuie à nouveau sur Entrée pour envoyer sans lui.",
    sendWithout: "Envoyer sans pilote",
  },
  vision: {
    stripLabel: "Images jointes",
    remove: (name: string) => `Retirer ${name}`,
    unnamed: "image collée",
    notice: "Les images partent avec ce message seulement : NOVA ne les enregistre pas.",
    cannotRead: (model: string) => `${model} ne lit pas les images.`,
    unknownModel: "Ce modèle n'indique pas s'il lit les images.",
    suggest: (model: string) => `Utiliser ${model}`,
    suggestPrice: (value: string) => `environ ${value} par million de jetons en entrée`,
    noVisionModel: "Aucun modèle du catalogue ne lit les images : retire-les pour envoyer.",
    chooseModel: "Choisir un modèle",
    removeAll: "Retirer les images",
  },
} as const;

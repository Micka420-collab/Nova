// French copy of lane L3 (skills). Owned by L3.
import type { BuiltinSkillName, SkillFileInfo, SkillScope, SkillWarningCode } from "@nova/shared";

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

/** French display names of the shipped skills (their SKILL.md names are identifiers). */
export const BUILTIN_SKILL_LABELS: Readonly<Record<BuiltinSkillName, string>> = {
  "comprendre-un-depot": "Comprendre un dépôt",
  "ecrire-des-tests-utiles": "Écrire des tests utiles",
  "preparer-une-release": "Préparer une release",
};

export const SKILL_SCOPE_LABELS: Readonly<Record<SkillScope, string>> = {
  builtin: "Livrée avec NOVA",
  user: "Installée",
  project: "Du projet",
};

export const SKILL_FILE_KIND_LABELS: Readonly<Record<SkillFileInfo["kind"], string>> = {
  skill_md: "instructions",
  script: "script",
  reference: "référence",
  asset: "ressource",
  other: "autre",
};

/** What each warning means for the user, with the subject (path, tool or host) when there is one. */
export const SKILL_WARNING_COPY: Readonly<Record<SkillWarningCode, (subject: string | null) => string>> = {
  unknown_tool: (subject) => `Outil demandé inconnu de NOVA : ${subject ?? "inconnu"} (ignoré).`,
  network_hosts: (subject) => `Dit contacter ${subject ?? "un site"} : chaque accès reste soumis à ta politique Internet.`,
  has_scripts: () => "Contient des scripts : ils ne s'exécutent que par une commande, soumise à tes permissions comme les autres.",
  binary_files: (subject) => `Fichier binaire, jamais lu par le modèle : ${subject ?? "inconnu"}.`,
  too_large: (subject) => `Instructions très longues (${subject ?? "SKILL.md"}) : elles occuperont beaucoup de contexte.`,
  name_mismatch: (subject) => `Le nom déclaré diffère du nom du dossier (${subject ?? "inconnu"}).`,
  secret_detected: (subject) => `Contenu sensible détecté ou fichier sensible écarté : ${subject ?? "inconnu"}.`,
};

/** Why a folder is refused (`skill_invalid:<reason>` from main). */
export const SKILL_INVALID_COPY: Readonly<Record<string, string>> = {
  missing_skill_md: "Paquet invalide : SKILL.md manquant.",
  missing_front_matter: "Paquet invalide : SKILL.md doit commencer par un bloc d'en-tête (---).",
  invalid_front_matter: "Paquet invalide : l'en-tête de SKILL.md n'est pas lisible.",
  missing_name: "Paquet invalide : l'en-tête ne donne pas de nom (name).",
  invalid_name: "Paquet invalide : le nom doit contenir seulement des minuscules, des chiffres et des tirets (64 caractères au plus).",
  missing_description: "Paquet invalide : l'en-tête ne donne pas de description.",
  description_too_long: "Paquet invalide : la description dépasse 1 024 caractères.",
  skill_md_too_large: "Paquet invalide : SKILL.md est trop long.",
  too_many_files: "Paquet refusé : trop de fichiers (200 au plus).",
  too_large: "Paquet refusé : trop volumineux (5 Mo au plus).",
  too_deep: "Paquet refusé : trop de dossiers imbriqués.",
  link_outside: "Paquet refusé : un lien pointe hors du dossier de la skill.",
  unsupported_entry: "Paquet refusé : il contient autre chose que des fichiers et des dossiers.",
  not_a_folder: "Ce dossier n'existe pas ou n'est pas lisible.",
};

export const skillsCopy = {
  display: {
    loaded: (name: string) => `Skill « ${name} » chargée`,
    file: (path: string) => `Fichier ${path}`,
    size: (chars: string) => `${chars} caractères`,
  },
  manager: {
    heading: "Skills",
    intro: "Des méthodes réutilisables que Nomi peut suivre. Une skill n'accorde aucun droit : chaque action reste soumise à tes permissions.",
    install: "Installer depuis un dossier…",
    loading: "Lecture des skills…",
    unavailable: "Les skills ne sont pas disponibles pour l'instant.",
    loadFailed: "Les skills n'ont pas pu être lues",
    retry: "Réessayer",
    sectionBuiltin: "Livrées avec NOVA",
    sectionUser: "Installées",
    sectionProject: "Dans ce projet",
    emptyUser: "Aucune skill installée.",
    emptyProject: "Aucune skill dans ce projet (dossier .nova/skills).",
    noProject: "Ouvre un projet pour activer une skill.",
    enableFor: (project: string) => `Activer pour ${project}`,
    enabledToast: (name: string) => `« ${name} » activée pour ce projet`,
    disabledToast: (name: string) => `« ${name} » désactivée pour ce projet`,
    toggleFailed: "L'activation n'a pas pu être modifiée",
    view: "Voir le contenu",
    uninstall: "Désinstaller",
    uninstallTitle: (name: string) => `Désinstaller « ${name} » ?`,
    uninstallBody: "Ses fichiers et son activation dans tous les projets seront supprimés.",
    uninstallConfirm: "Désinstaller",
    cancel: "Annuler",
    uninstalled: (name: string) => `« ${name} » désinstallée`,
    uninstallFailed: "La skill n'a pas pu être désinstallée",
    previewFailed: "Ce dossier n'a pas pu être lu",
    listLabel: (section: string) => `Skills : ${section}`,
    meta: (files: number, version: string | null) => `${plural(files, "fichier", "fichiers")}${version ? ` · version ${version}` : ""}`,
  },
  preview: {
    installTitle: "Aperçu avant installation",
    enableTitle: "Aperçu avant activation",
    viewTitle: "Contenu de la skill",
    toInstall: "Pas encore installée",
    reading: "Lecture du paquet…",
    replaces: "Une skill installée du même nom sera remplacée ; il faudra la réactiver dans chaque projet.",
    declaredHeading: "Ce que la skill déclare",
    declaredNote: "Ces déclarations sont indicatives et n'accordent aucun droit : NOVA applique toujours tes permissions.",
    tools: "Outils",
    hosts: "Sites contactés",
    scripts: "Scripts",
    none: "aucun",
    warningsHeading: "Points d'attention",
    filesHeading: (count: number) => `Fichiers (${count})`,
    contentHeading: "Instructions (SKILL.md)",
    install: "Installer",
    replace: "Remplacer",
    enable: "Activer pour ce projet",
    close: "Fermer",
    installed: (name: string, files: number) => `Skill « ${name} » installée · ${plural(files, "fichier", "fichiers")}`,
    expired: "Cet aperçu a expiré : ouvre à nouveau le dossier.",
    previewRequired: "Le contenu a changé depuis l'aperçu : relis-le puis active la skill.",
    excluded: "Ce dossier est exclu pour l'agent (.novaignore).",
    unknownInvalid: "Paquet invalide.",
    version: (version: string | null) => (version ? `version ${version}` : "version inconnue"),
  },
  mission: {
    heading: "Skills utilisées",
    loadedAt: (name: string, path: string | null) => (path ? `${name} · ${path}` : name),
  },
} as const;

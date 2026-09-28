export type NomiState =
  | "offline"
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "waiting"
  | "speaking"
  | "success"
  | "error";

export const NOMI_STATES = [
  "offline",
  "idle",
  "listening",
  "thinking",
  "working",
  "waiting",
  "speaking",
  "success",
  "error",
] as const satisfies readonly NomiState[];

export const NOMI_STATE_LABELS: Record<NomiState, string> = {
  offline: "Nomi est hors ligne",
  idle: "Nomi est disponible",
  listening: "Nomi écoute",
  thinking: "Nomi réfléchit",
  working: "Nomi travaille",
  waiting: "Nomi attend ta réponse",
  speaking: "Nomi parle",
  success: "Terminé",
  error: "Quelque chose a échoué",
};

/**
 * What Nomi is doing, from the real tool that runs (NOMI.md §6, second axis). Mirrors
 * `NomiActivity` of @nova/companion (kept here: the UI package has no domain dependency).
 */
export type NomiActivity = "none" | "reading" | "searching" | "editing" | "running" | "testing" | "debugging";

export const NOMI_ACTIVITIES = [
  "none",
  "reading",
  "searching",
  "editing",
  "running",
  "testing",
  "debugging",
] as const satisfies readonly NomiActivity[];

export const NOMI_ACTIVITY_LABELS: Record<Exclude<NomiActivity, "none">, string> = {
  reading: "Nomi lit un fichier",
  searching: "Nomi cherche",
  editing: "Nomi modifie un fichier",
  running: "Nomi lance une commande",
  testing: "Nomi lance les tests",
  debugging: "Nomi cherche la cause d'une erreur",
};

export type NomiAccessory = "glasses" | "probe" | "tool" | "card";

/**
 * Accessory held for a state × activity pair (NOMI.md §8): only while thinking or working, and
 * only when the activity matches the pose (reading/searching/debugging think, the rest work).
 */
export function nomiAccessory(state: NomiState, activity: NomiActivity): NomiAccessory | null {
  if (state === "thinking") {
    if (activity === "reading" || activity === "searching") return "glasses";
    if (activity === "debugging") return "probe";
  }
  if (state === "working") {
    if (activity === "editing") return "tool";
    if (activity === "running" || activity === "testing") return "card";
  }
  return null;
}

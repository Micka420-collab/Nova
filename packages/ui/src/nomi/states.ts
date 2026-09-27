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

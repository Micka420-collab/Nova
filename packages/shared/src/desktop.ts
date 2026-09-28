// J2-B L7: desktop presence and chat autopilot.
// - Tray / menu bar: Nomi's real status (from runtime events only). Closing the window keeps
//   missions, terminals and schedules running ONLY when the user opted in
//   (`settings.desktop.keepRunningOnClose`, explained where it is turned on). Quitting while
//   something runs asks first (native dialog in main listing what would stop).
// - Onboarding: a profile (code / documents) and a detail density applied to mission cards.
// - Chat autopilot (Discuter): a cheap classifier call picks the reasoning effort and web on/off
//   for one message; the choice is shown before sending and the user can override it.
// - Vision: pasting an image suggests a model of the catalog whose `inputModalities` has "image"
//   (never a hard-coded id).
import { z } from "zod";
import { ModelIdSchema } from "./ids";

export const ONBOARDING_PROFILES = ["code", "documents"] as const;
export type OnboardingProfile = (typeof ONBOARDING_PROFILES)[number];

/** Mission cards: final result only, key steps, or every event. Display only, never capabilities. */
export const DETAIL_DENSITIES = ["result", "key_steps", "all"] as const;
export type DetailDensity = (typeof DETAIL_DENSITIES)[number];

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** What is running now (tray menu, quit warning). Counts are real, from the services. */
export interface DesktopActivity {
  runningMissions: number;
  waitingApprovals: number;
  runningTerminals: number;
  runningProcesses: number;
  activeSchedules: number;
  nextScheduledAt: number | null;
}

export interface DesktopState {
  /** A tray icon could be created on this system (false on some Linux desktops). */
  trayAvailable: boolean;
  keepRunningOnClose: boolean;
  activity: DesktopActivity;
}

/** Pushed on `desktop.onEvent`. */
export type DesktopEvent = { type: "desktop.state"; state: DesktopState };

// ---------------------------------------------------------------------------
// Chat autopilot

export const AUTOPILOT_LIMITS = {
  /** Characters of the message the classifier sees (the start of it). */
  excerptMaxChars: 4_000,
  rationaleMaxChars: 200,
} as const;

export const AutopilotClassifyRequestSchema = z.object({
  content: z.string().trim().min(1).max(AUTOPILOT_LIMITS.excerptMaxChars),
  /** Model the answer will use (its reasoning support decides whether an effort applies). */
  modelId: ModelIdSchema,
  hasImages: z.boolean(),
});
export type AutopilotClassifyRequest = z.infer<typeof AutopilotClassifyRequestSchema>;

export interface AutopilotChoice {
  /** null = the target model does not support reasoning (catalog), so no effort is sent. */
  reasoningEffort: ReasoningEffort | null;
  webSearch: boolean;
  /** French, short, shown next to the choice. */
  rationale: string;
  /** Model that classified; null when the choice is the local fallback. */
  classifierModelId: string | null;
  costUsd: number | null;
  /** `fallback`: the classifier was unavailable; the choice is NOVA's default, said so in the UI. */
  source: "classifier" | "fallback";
}

// ---------------------------------------------------------------------------
// Images pasted in Discuter (sent to the provider for this message only, never stored).

export const CHAT_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const CHAT_IMAGE_LIMITS = { maxImages: 4, maxBase64Chars: 8_000_000 } as const;
export const ChatImageSchema = z.object({
  mediaType: z.enum(CHAT_IMAGE_MEDIA_TYPES),
  dataBase64: z
    .string()
    .min(4)
    .max(CHAT_IMAGE_LIMITS.maxBase64Chars)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "image invalide"),
  name: z.string().max(200).nullable(),
});
export type ChatImage = z.infer<typeof ChatImageSchema>;

// Heuristic flags for UNTRUSTED text sent by MCP servers (tool descriptions, titles). A flag never
// changes a permission decision: it only lets the UI warn the user (M1, W5 scenario 7). The
// heuristic is announced as such; a clean result proves nothing.

export type UntrustedTextFlag =
  /** Tries to override previous/system instructions or the user's intent. */
  | "override_instructions"
  /** Orders the model to do something (call a tool first, always, never tell…). */
  | "imperative"
  /** Asks to hide something from the user. */
  | "concealment"
  /** Mentions secrets, credentials or sensitive files. */
  | "sensitive_target"
  /** Hidden markup or invisible characters meant for the model, not the user. */
  | "hidden_markup";

const RULES: readonly { flag: UntrustedTextFlag; pattern: RegExp }[] = [
  {
    flag: "override_instructions",
    pattern:
      /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|system|other)\b.{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
  },
  { flag: "override_instructions", pattern: /\b(ignore[rsz]?|oublie[rsz]?)\b.{0,30}\b(instructions?|consignes?|règles?)\b/i },
  { flag: "override_instructions", pattern: /\b(system prompt|new instructions|you are now|act as)\b/i },
  {
    flag: "imperative",
    pattern:
      /\b(you must|you should always|always (call|use|run|invoke)|before (using|calling) any other tool|must be called first|do this first)\b/i,
  },
  { flag: "imperative", pattern: /\b(tu dois|vous devez|appelle toujours|utilise toujours|avant tout autre outil)\b/i },
  {
    flag: "concealment",
    pattern:
      /\b(do not|don't|never) (tell|inform|mention|reveal|show)\b.{0,30}\b(user|human)\b|\bwithout (telling|informing) the user\b/i,
  },
  { flag: "concealment", pattern: /\b(ne (le )?dis pas|sans (le dire|prévenir))\b.{0,30}\butilisateur\b/i },
  {
    flag: "sensitive_target",
    pattern:
      /(~\/\.ssh|\bid_rsa\b|\bid_ed25519\b|\.env\b|\bapi[_ -]?keys?\b|\bpasswords?\b|\bcredentials?\b|\bsecrets?\b|\bprivate key\b|\bexfiltrat)/i,
  },
  { flag: "hidden_markup", pattern: /<\s*\/?\s*(important|system|instructions?|secret|hidden)\b[^>]*>/i },
  // Zero-width and bidi control characters hide text from the reader.
  { flag: "hidden_markup", pattern: /[​-‏‪-‮⁠-⁤﻿]/ },
];

/** Distinct flags found in `text`, in a stable order. */
export function flagUntrustedText(text: string): UntrustedTextFlag[] {
  const found = new Set<UntrustedTextFlag>();
  for (const { flag, pattern } of RULES) if (pattern.test(text)) found.add(flag);
  const order: readonly UntrustedTextFlag[] = [
    "override_instructions",
    "imperative",
    "concealment",
    "sensitive_target",
    "hidden_markup",
  ];
  return order.filter((flag) => found.has(flag));
}

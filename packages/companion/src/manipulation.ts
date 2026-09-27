// N11 anti-manipulation: phrases Nomi never says, in any tone (NOMI.md §2.3, §4, P13).
// Used as a content test over all companion copy; also usable by main before showing any
// model-generated label next to Nomi.

/** Whole-word match that treats accented letters as letters (JS `\b` is ASCII-only). */
function word(source: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "iu");
}

export const FORBIDDEN_NOMI_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /!/u, reason: "point d'exclamation" },
  { pattern: word("tu m'as manqué|tu me manques|tu nous manques"), reason: "culpabilisation" },
  { pattern: word("ça fait longtemps|depuis \\d+ jours|tu n'as pas ouvert"), reason: "compteur d'absence" },
  { pattern: word("reviens|reviens vite|ne pars pas|à très vite"), reason: "relance d'attention" },
  { pattern: word("je suis triste|nomi est triste|je m'ennuie|s'ennuie|je suis seul"), reason: "émotion simulée" },
  { pattern: word("désolée?|pardon|je suis nul"), reason: "excuse (Nomi dit ce qui s'est passé)" },
  { pattern: word("bravo|félicitations|tu es rapide|bien joué|champion"), reason: "qualifie l'utilisateur" },
  { pattern: word("tu as gagné|étoiles?|séries?|streaks?|scores?|badges?|récompenses?|niveau \\d+"), reason: "gamification" },
  { pattern: word("vite|dépêche-toi|urgent|dernière chance|maintenant ou jamais"), reason: "urgence artificielle" },
  { pattern: word("prêt pour la production"), reason: "affirmation non vérifiée" },
  { pattern: word("je pense que|à mon avis"), reason: "opinion du modèle attribuée à Nomi" },
];

/** Reasons the text breaks N11; empty when the text is acceptable. */
export function findManipulation(text: string): string[] {
  return FORBIDDEN_NOMI_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ reason }) => reason);
}

const SAMPLE_ARGS: readonly unknown[][] = [
  [2, 3, 4, 5],
  [1, 1, 1, 1],
  [0, 0, 0, 0],
  [null, null, null, null],
  ["Facturation", "Facturation", "Facturation", "Facturation"],
];

/**
 * Every string a copy table can produce: plain strings, and functions called with sample
 * arguments (numbers, null, text). Paths are returned for readable test failures.
 */
export function collectCopyStrings(node: unknown, path = "copy"): { path: string; text: string }[] {
  if (typeof node === "string") return [{ path, text: node }];
  if (typeof node === "function") {
    const out: { path: string; text: string }[] = [];
    for (const args of SAMPLE_ARGS) {
      try {
        const value: unknown = (node as (...a: unknown[]) => unknown)(...args);
        if (typeof value === "string") out.push({ path: `${path}(${args.map(String).join(", ")})`, text: value });
      } catch {
        // A sample argument of the wrong shape: other samples cover the function.
      }
    }
    return out;
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, child]) => collectCopyStrings(child, `${path}.${key}`));
  }
  return [];
}

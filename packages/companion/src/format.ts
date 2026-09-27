// French number, money, time and plural helpers for Nomi's copy (no Intl data dependency).

/** "4,10 $"; "au moins 0,02 $" when some costs are unknown. */
export function formatUsd(value: number, lowerBound = false): string {
  const text = `${value.toFixed(2).replace(".", ",")} $`;
  return lowerBound ? `au moins ${text}` : text;
}

/** "14 h 05" in local time. */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${date.getHours()} h ${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "1 fichier", "3 fichiers", "0 fichier" (French: 0 and 1 are singular). */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count <= 1 ? singular : pluralForm}`;
}

/** Inline code-ish rendering of a command (already redacted by the caller), capped. */
export function shortCommand(argv: readonly string[], max = 60): string {
  const text = argv.join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Last path segment, for "`cart.test.ts` échoue". */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-1) || path;
}

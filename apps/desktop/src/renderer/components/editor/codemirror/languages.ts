// Language support loaded on demand from @codemirror/language-data (each language is its own chunk).
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Language of a file from its name (extension or exact filename), null when unknown. */
export function describeLanguage(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, basename(path));
}

/** Display name for the status bar ("TypeScript", "Python"…); null = plain text. */
export function languageName(path: string): string | null {
  return describeLanguage(path)?.name ?? null;
}

/** Loads the language support (cached by language-data after the first load); null for plain text. */
export async function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const description = describeLanguage(path);
  if (!description) return null;
  try {
    return description.support ?? (await description.load());
  } catch {
    // A chunk that fails to load leaves the file readable as plain text.
    return null;
  }
}

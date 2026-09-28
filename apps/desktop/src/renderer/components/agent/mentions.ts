// @-mentions of the goal composer (FEATURES C6 v1: files, folders, URLs) and the context estimate
// of the inspector (C5 v1). Mentions live in the goal text itself (`@src/cart.ts`, `@src/`,
// `@https://…`), so what the user sees is exactly what is sent. Pure: tested without a DOM.
import { isCanonicalRelativePath } from "@nova/shared";

export type Mention =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "url"; url: string };

/** `@query` being typed at the end of the text (after a space or at the start), or null. */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]{0,200})$/.exec(text);
  return match ? (match[1] ?? "") : null;
}

export function mentionToken(mention: Mention): string {
  switch (mention.kind) {
    case "file":
      return `@${mention.path}`;
    case "folder":
      return `@${mention.path}/`;
    case "url":
      return `@${mention.url}`;
  }
}

/** Replaces the `@query` being typed with the chosen mention (and a space to keep typing). */
export function insertMention(text: string, mention: Mention): string {
  const query = mentionQuery(text);
  const base = query === null ? `${text}${text === "" || /\s$/.test(text) ? "" : " "}` : text.slice(0, text.length - query.length - 1);
  return `${base}${mentionToken(mention)} `;
}

/** An http(s) URL the user typed after `@`; anything else is not proposed as a page. */
export function asUrl(query: string): string | null {
  try {
    const url = new URL(query);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Mentions present in the text, in order, without duplicates. Invalid paths stay plain text. */
export function extractMentions(text: string): Mention[] {
  const found: Mention[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const raw = (match[1] ?? "").replace(/[.,;:!?)]+$/, "");
    const url = /^https?:\/\//.test(raw) ? asUrl(raw) : null;
    let mention: Mention | null = null;
    if (url) mention = { kind: "url", url };
    else if (raw.endsWith("/") && isCanonicalRelativePath(raw.slice(0, -1)) && raw.length > 1) mention = { kind: "folder", path: raw.slice(0, -1) };
    else if (raw !== "" && isCanonicalRelativePath(raw)) mention = { kind: "file", path: raw };
    if (!mention) continue;
    const token = mentionToken(mention);
    if (seen.has(token)) continue;
    seen.add(token);
    found.push(mention);
  }
  return found;
}

/** Removes every occurrence of a mention's token from the text. */
export function removeMention(text: string, mention: Mention): string {
  const token = mentionToken(mention);
  return text
    .split(/(\s+)/)
    .filter((part) => part.replace(/[.,;:!?)]+$/, "") !== token)
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Suggestions for a query from the project's file search: the files, and the folders on their
 * path whose name matches (a folder is proposed once, before its files).
 */
export function mentionSuggestions(query: string, paths: readonly string[], limit = 8): Mention[] {
  const needle = query.toLowerCase();
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      const folder = segments.slice(0, index).join("/");
      if (needle !== "" && (segments[index - 1] ?? "").toLowerCase().includes(needle)) folders.add(folder);
    }
  }
  const url = asUrl(query);
  const items: Mention[] = [
    ...(url ? [{ kind: "url" as const, url }] : []),
    ...[...folders].map((path) => ({ kind: "folder" as const, path })),
    ...paths.map((path) => ({ kind: "file" as const, path })),
  ];
  return items.slice(0, limit);
}

/** ≈ tokens of a text (4 characters per token): always shown as an approximation. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

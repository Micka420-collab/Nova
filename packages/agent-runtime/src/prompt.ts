// What the provider sees: system prompt, context selection and conversation titles.
import type { ChatMessageInput } from "@nova/providers";
import type { Message } from "@nova/shared";

export const NOVA_SYSTEM_PROMPT = [
  "Tu es Nomi, le compagnon de l'atelier NOVA.",
  "Réponds dans la langue de l'utilisateur (en français par défaut),",
  "de façon claire, directe et chaleureuse.",
  "Dans cette version, tu n'as accès ni aux fichiers, ni au terminal, ni à Internet.",
  "N'affirme jamais avoir exécuté, testé ou vérifié quelque chose que tu n'as pas pu faire :",
  "dis clairement ce qui reste à vérifier.",
].join(" ");

export const DEFAULT_CONTEXT_MAX_CHARS = 120_000;
const TITLE_MAX_CHARS = 60;
const FALLBACK_TITLE = "Nouvelle conversation";

/** First non-blank line, whitespace collapsed, at most 60 characters (cut at a word boundary + "…"). */
export function buildConversationTitle(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  if (line === undefined) return FALLBACK_TITLE;
  // Code points, so an emoji is never split in half.
  const chars = Array.from(line);
  if (chars.length <= TITLE_MAX_CHARS) return line;
  const cut = chars.slice(0, TITLE_MAX_CHARS - 1).join("");
  const boundary = chars[TITLE_MAX_CHARS - 1] === " " ? cut.length : cut.lastIndexOf(" ");
  const head = (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[\s,;:.!?\-–—]+$/u, "");
  return `${head || cut}…`;
}

/** Messages worth sending back as context: user turns and non-empty complete answers. */
function isContextMessage(message: Message): boolean {
  if (message.role === "user") return true;
  return message.status === "complete" && message.content.trim().length > 0;
}

/**
 * Builds the provider request: the system prompt, then the most recent context messages whose
 * contents fit in `maxChars` (system prompt not counted). The latest user message is always kept,
 * even alone over budget, and the window never opens on an answer whose question was dropped.
 */
export function buildProviderMessages(
  history: Message[],
  options: { maxChars?: number } = {},
): ChatMessageInput[] {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const context = history.filter(isContextMessage);
  let start = context.length;
  let used = 0;
  for (let index = context.length - 1; index >= 0; index -= 1) {
    used += context[index]?.content.length ?? 0;
    if (used > maxChars) break;
    start = index;
  }
  const latestUser = context.findLastIndex((message) => message.role === "user");
  if (latestUser !== -1 && latestUser < start) start = latestUser;
  while (context[start]?.role === "assistant") start += 1;
  return [
    { role: "system", content: NOVA_SYSTEM_PROMPT },
    ...context.slice(start).map((message) => ({ role: message.role, content: message.content })),
  ];
}

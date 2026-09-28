// Readable extraction (W2): Readability over a linkedom DOM (no jsdom), then Markdown by turndown.
// Output is untrusted text; links are made absolute against the final URL, scripts and media are
// dropped, and the result is capped with an explicit truncation marker.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/** Visible marker appended to truncated Markdown; also how the cache knows a page was truncated. */
export const TRUNCATION_MARKER = "\n\n[… contenu tronqué : la page dépasse la limite de lecture de NOVA.]";

export interface ExtractedPage {
  title: string | null;
  markdown: string;
}

function createTurndown(baseUrl: string): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.remove(["script", "style", "noscript", "iframe", "object", "embed", "form", "button", "select", "textarea"]);
  service.addRule("absoluteLinks", {
    filter: "a",
    replacement: (content, node) => {
      const href = "getAttribute" in node && typeof node.getAttribute === "function" ? node.getAttribute("href") : null;
      const text = content.trim();
      if (!href) return text;
      let absolute: URL;
      try {
        absolute = new URL(href, baseUrl);
      } catch {
        return text;
      }
      // javascript:, data:, mailto:… links are kept as plain text.
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return text;
      return text ? `[${text}](${absolute.href})` : "";
    },
  });
  // Images cost tokens and may be tracking pixels: keep the alt text only.
  service.addRule("imageAlt", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = "getAttribute" in node && typeof node.getAttribute === "function" ? node.getAttribute("alt") : null;
      return alt ? `[image : ${alt.trim()}]` : "";
    },
  });
  return service;
}

function cleanTitle(value: string | null | undefined): string | null {
  const title = value?.replace(/\s+/g, " ").trim() ?? "";
  return title === "" ? null : title.slice(0, 300);
}

/** HTML page → readable Markdown. Falls back to the whole body when Readability finds no article. */
export function htmlToMarkdown(html: string, baseUrl: string): ExtractedPage {
  const turndown = createTurndown(baseUrl);
  const { document } = parseHTML(html);
  const documentTitle = cleanTitle(document.title);
  let article: ReturnType<Readability["parse"]> = null;
  try {
    // linkedom implements the DOM subset Readability uses; its types are its own, not lib.dom's.
    article = new Readability(document as unknown as Document).parse();
  } catch {
    article = null;
  }
  if (article?.content) {
    return { title: cleanTitle(article.title) ?? documentTitle, markdown: normalizeMarkdown(turndown.turndown(article.content)) };
  }
  const body = document.body?.innerHTML ?? html;
  return { title: documentTitle, markdown: normalizeMarkdown(turndown.turndown(body)) };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

/** Caps text at `maxChars` (cut at a line or word boundary when close) and appends the marker. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
  const cut = boundary > maxChars * 0.8 ? slice.slice(0, boundary) : slice;
  return { text: `${cut.trimEnd()}${TRUNCATION_MARKER}`, truncated: true };
}

/** Converts a decoded body of an allowed content type to Markdown. */
export function bodyToMarkdown(kind: "html" | "text" | "json", body: string, baseUrl: string): ExtractedPage {
  if (kind === "html") return htmlToMarkdown(body, baseUrl);
  if (kind === "json") {
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Invalid JSON is shown as received.
    }
    return { title: null, markdown: `\`\`\`json\n${pretty.replaceAll("```", "`​``")}\n\`\`\`` };
  }
  return { title: null, markdown: body.trim() };
}

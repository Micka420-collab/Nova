// Citation chips in agent messages (VISUAL.md §5.5): `[src/form.tsx:13]` becomes a chip that opens
// the file at that line. Only bracketed workspace-relative paths qualify; anything else stays text.
import { isCanonicalRelativePath } from "@nova/shared";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; line: number | null; label: string };

// A path with an extension, optional `:line`; no spaces, no scheme, no leading slash.
const CITATION = /\[([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+)(?::(\d{1,7}))?\]/g;

export function splitCitations(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const [whole, path, line] = match;
    const index = match.index;
    if (!path || !isCanonicalRelativePath(path)) continue;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    const name = path.split("/").at(-1) ?? path;
    parts.push({ kind: "file", path, line: line ? Number(line) : null, label: line ? `${name}:${line}` : name });
    last = index + whole.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

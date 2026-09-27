// Syntax highlighting through classes (`nv-syn-*`, styled by @nova/ui code.css), never inline
// colors: one palette for the editor and the chat code blocks, both themes, no injected styles.
import { tagHighlighter, tags as t, type Highlighter } from "@lezer/highlight";

/** Lezer tag → NOVA syntax role (VISUAL §2.3). Order matters: the first matching tag wins. */
export const SYNTAX_ROLES = [
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], role: "comment" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self], role: "keyword" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], role: "function" },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue], role: "string" },
  { tag: [t.number, t.integer, t.float, t.unit], role: "number" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], role: "type" },
  { tag: [t.propertyName, t.definition(t.propertyName), t.labelName], role: "property" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace, t.derefOperator], role: "operator" },
  { tag: [t.bool, t.null, t.atom, t.constant(t.variableName), t.standard(t.variableName)], role: "constant" },
  { tag: [t.tagName], role: "tag" },
  { tag: [t.attributeName], role: "attribute" },
  { tag: [t.regexp, t.escape, t.special(t.regexp)], role: "regex" },
  { tag: [t.invalid], role: "invalid" },
  { tag: [t.heading], role: "heading" },
  { tag: [t.strong], role: "strong" },
  { tag: [t.emphasis], role: "emphasis" },
  { tag: [t.link, t.url], role: "link" },
  { tag: [t.variableName, t.definition(t.variableName), t.name, t.content], role: "plain" },
] as const;

export type SyntaxRole = (typeof SYNTAX_ROLES)[number]["role"];

/** Highlighter emitting `nv-syn-<role>` classes; usable with `syntaxHighlighting` and `highlightCode`. */
export const novaHighlighter: Highlighter = tagHighlighter(
  SYNTAX_ROLES.map(({ tag, role }) => ({ tag: [...tag], class: `nv-syn-${role}` })),
);

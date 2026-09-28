// SKILL.md front matter (Agent Skills format): a YAML block between `---` lines at the very top.
// NOVA reads a deliberately small YAML subset (no new dependency): top-level `key: value` pairs
// with plain or quoted scalars, block scalars (`|`, `>`), flow lists (`[a, b]`), block lists
// (`- item`) and one level of nested map (`metadata:`). Anything else is refused with a reason,
// never guessed. Fields NOVA does not use (license, compatibility…) are accepted and ignored.
import { SKILL_LIMITS, SKILL_NAME_PATTERN } from "@nova/shared";
import { invalidSkill } from "./errors";

export interface SkillFrontMatter {
  name: string;
  description: string;
  /** `version`, or `metadata.version`; null = not declared. */
  version: string | null;
  /** `allowed-tools` (space- or comma-separated string, or a list). */
  allowedTools: string[];
  /** `hosts` the skill says it contacts (information only). */
  hosts: string[];
}

export interface ParsedSkillMd {
  frontMatter: SkillFrontMatter;
  /** Everything after the closing `---` (leading blank lines removed). */
  body: string;
}

type YamlValue = string | string[] | Record<string, string>;

const KEY_LINE = /^([A-Za-z][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const NESTED_KEY_LINE = /^[ \t]+([A-Za-z][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^[ \t]+-(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^([|>])([+-]?)$/;

function failure(message: string): never {
  throw invalidSkill("invalid_front_matter", message);
}

/** A plain or quoted YAML scalar on one line (comments after a plain scalar are dropped). */
function scalar(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) failure("unterminated double-quoted value");
    return text
      .slice(1, -1)
      .replace(/\\(["\\/nt])/g, (_match, escaped: string) => (escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped));
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) failure("unterminated single-quoted value");
    return text.slice(1, -1).replace(/''/g, "'");
  }
  const comment = text.search(/[ \t]#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

function flowList(raw: string): string[] {
  const text = raw.trim();
  if (!text.endsWith("]")) failure("unterminated list");
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((item) => scalar(item)).filter((item) => item !== "");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function blockScalar(style: string, chomp: string, lines: string[]): string {
  const content = lines.filter((line) => line.trim() !== "");
  const indent = content.length === 0 ? 0 : Math.min(...content.map(indentOf));
  const stripped = lines.map((line) => line.slice(indent));
  let text: string;
  if (style === "|") {
    text = stripped.join("\n");
  } else {
    // Folded: single newlines become spaces, blank lines stay paragraph breaks.
    text = stripped
      .join("\n")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, " "))
      .join("\n");
  }
  text = text.replace(/\n+$/, "");
  return chomp === "+" ? `${text}\n` : text;
}

/** Parses the YAML subset of a front matter block into top-level values. */
export function parseYamlSubset(source: string): Map<string, YamlValue> {
  const values = new Map<string, YamlValue>();
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    index += 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t") && /^\s*\t/.test(line)) failure("tabs are not allowed for indentation");
    const match = KEY_LINE.exec(line);
    if (!match) failure(`unexpected line ${index}`);
    const key = (match[1] as string).toLowerCase();
    if (values.has(key)) failure(`duplicate key "${key}"`);
    const inline = (match[2] ?? "").trim();
    // Indented lines that belong to this key.
    const children: string[] = [];
    while (index < lines.length) {
      const next = lines[index] as string;
      if (next.trim() !== "" && indentOf(next) === 0) break;
      children.push(next);
      index += 1;
    }
    while (children.length > 0 && (children[children.length - 1] as string).trim() === "") children.pop();

    const block = BLOCK_SCALAR.exec(inline);
    if (block) {
      values.set(key, blockScalar(block[1] as string, block[2] as string, children));
      continue;
    }
    if (inline !== "" && !inline.startsWith("#")) {
      if (children.some((child) => child.trim() !== "")) {
        // A plain scalar continued on indented lines (YAML folds them with spaces).
        if (/^["'[]/.test(inline)) failure(`unexpected indented line after "${key}"`);
        values.set(key, [scalar(inline), ...children.map((child) => child.trim()).filter(Boolean)].join(" "));
        continue;
      }
      values.set(key, inline.startsWith("[") ? flowList(inline) : scalar(inline));
      continue;
    }
    const content = children.filter((child) => child.trim() !== "" && !child.trimStart().startsWith("#"));
    if (content.length === 0) {
      values.set(key, "");
      continue;
    }
    if (content.every((child) => LIST_ITEM.test(child))) {
      values.set(
        key,
        content.map((child) => scalar(LIST_ITEM.exec(child)?.[1] ?? "")).filter((item) => item !== ""),
      );
      continue;
    }
    if (content.every((child) => NESTED_KEY_LINE.test(child))) {
      const map: Record<string, string> = {};
      for (const child of content) {
        const nested = NESTED_KEY_LINE.exec(child) as RegExpExecArray;
        map[(nested[1] as string).toLowerCase()] = scalar(nested[2] ?? "");
      }
      values.set(key, map);
      continue;
    }
    failure(`unsupported structure under "${key}"`);
  }
  return values;
}

function asText(value: YamlValue | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return null;
  return value;
}

function asList(value: YamlValue | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split(/[\s,]+/).filter((item) => item !== "");
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter((item) => item !== "");
  failure("expected a list");
}

/** Splits and validates a SKILL.md. Throws `invalid_skill` with the precise reason. */
export function parseSkillMd(text: string): ParsedSkillMd {
  if (text.length > SKILL_LIMITS.skillMdMaxChars) {
    throw invalidSkill("skill_md_too_large", `SKILL.md is longer than ${SKILL_LIMITS.skillMdMaxChars} characters`);
  }
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trimEnd() !== "---") throw invalidSkill("missing_front_matter", "SKILL.md must start with a --- front matter block");
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) throw invalidSkill("missing_front_matter", "the front matter block of SKILL.md is not closed by ---");
  const values = parseYamlSubset(lines.slice(1, end).join("\n"));

  const name = asText(values.get("name"))?.trim() ?? "";
  if (name === "") throw invalidSkill("missing_name", "SKILL.md has no name");
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw invalidSkill("invalid_name", "the name must be 1-64 lowercase letters, digits or single hyphens", name.slice(0, 80));
  }
  const description = (asText(values.get("description")) ?? "").replace(/\s+/g, " ").trim();
  if (description === "") throw invalidSkill("missing_description", "SKILL.md has no description");
  if (description.length > SKILL_LIMITS.descriptionMaxChars) {
    throw invalidSkill("description_too_long", `the description is longer than ${SKILL_LIMITS.descriptionMaxChars} characters`);
  }
  const metadata = values.get("metadata");
  const metadataVersion = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata["version"] ?? null) : null;
  const version = (asText(values.get("version")) ?? metadataVersion ?? "").trim().slice(0, 64) || null;

  return {
    frontMatter: {
      name,
      description,
      version,
      allowedTools: asList(values.get("allowed-tools")).slice(0, 100),
      hosts: asList(values.get("hosts")).map((host) => host.toLowerCase()).slice(0, 100),
    },
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
  };
}

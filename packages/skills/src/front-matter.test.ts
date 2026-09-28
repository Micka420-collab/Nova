import { describe, expect, it } from "vitest";
import { SKILL_LIMITS } from "@nova/shared";
import { SkillError } from "./errors";
import { parseSkillMd } from "./front-matter";

function reasonOf(text: string): string | null {
  try {
    parseSkillMd(text);
    return "accepted";
  } catch (error) {
    return error instanceof SkillError ? error.reason : "not a SkillError";
  }
}

describe("parseSkillMd", () => {
  it("reads the Agent Skills fields, block scalars and lists", () => {
    const parsed = parseSkillMd(
      [
        "﻿---",
        "name: pdf-tools",
        "description: >",
        "  Extract text and tables",
        "  from PDF files.",
        "license: MIT",
        "allowed-tools: read_file Bash(git:*)",
        "hosts:",
        "  - API.example.com",
        "  - 'cdn.example.com'",
        "metadata:",
        "  author: someone",
        '  version: "2.1"',
        "---",
        "",
        "# PDF tools",
        "Body.",
      ].join("\r\n"),
    );
    expect(parsed.frontMatter).toEqual({
      name: "pdf-tools",
      description: "Extract text and tables from PDF files.",
      version: "2.1",
      allowedTools: ["read_file", "Bash(git:*)"],
      hosts: ["api.example.com", "cdn.example.com"],
    });
    expect(parsed.body).toBe("# PDF tools\nBody.");
  });

  it("accepts quoted scalars, flow lists and comments", () => {
    const parsed = parseSkillMd(
      ['---', '# a comment', 'name: "demo"', "description: 'It''s a demo' ", "allowed-tools: [read_file, glob]", "version: 1.0 # stable", "---", "x"].join("\n"),
    );
    expect(parsed.frontMatter.description).toBe("It's a demo");
    expect(parsed.frontMatter.allowedTools).toEqual(["read_file", "glob"]);
    expect(parsed.frontMatter.version).toBe("1.0");
  });

  it("refuses an invalid SKILL.md with the precise reason", () => {
    expect(reasonOf("# no front matter")).toBe("missing_front_matter");
    expect(reasonOf("---\nname: x\ndescription: y\n")).toBe("missing_front_matter");
    expect(reasonOf("---\ndescription: y\n---\n")).toBe("missing_name");
    expect(reasonOf("---\nname: Not_Valid\ndescription: y\n---\n")).toBe("invalid_name");
    expect(reasonOf("---\nname: double--hyphen\ndescription: y\n---\n")).toBe("invalid_name");
    expect(reasonOf(`---\nname: ${"a".repeat(65)}\ndescription: y\n---\n`)).toBe("invalid_name");
    expect(reasonOf("---\nname: ok\n---\n")).toBe("missing_description");
    expect(reasonOf(`---\nname: ok\ndescription: ${"d".repeat(SKILL_LIMITS.descriptionMaxChars + 1)}\n---\n`)).toBe("description_too_long");
    expect(reasonOf("---\nname: ok\nname: again\ndescription: y\n---\n")).toBe("invalid_front_matter");
    expect(reasonOf("---\nname: ok\ndescription: \"unterminated\n---\n")).toBe("invalid_front_matter");
    expect(reasonOf("---\nname: ok\ndescription: y\nhosts:\n  - a.example\n  b: c\n---\n")).toBe("invalid_front_matter");
    expect(reasonOf(`---\nname: ok\ndescription: y\n---\n${"x".repeat(SKILL_LIMITS.skillMdMaxChars)}`)).toBe("skill_md_too_large");
  });
});

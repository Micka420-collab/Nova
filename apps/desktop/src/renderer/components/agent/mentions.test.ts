import { describe, expect, it } from "vitest";
import { approxTokens, extractMentions, insertMention, mentionQuery, mentionSuggestions, removeMention } from "./mentions";

describe("goal mentions", () => {
  it("detects the @query being typed at the end only", () => {
    expect(mentionQuery("regarde @src/ca")).toBe("src/ca");
    expect(mentionQuery("@")).toBe("");
    expect(mentionQuery("mail@exemple.com")).toBeNull();
    expect(mentionQuery("regarde @src/cart.ts puis")).toBeNull();
  });

  it("inserts the chosen mention in place of the query", () => {
    expect(insertMention("regarde @ca", { kind: "file", path: "src/cart.ts" })).toBe("regarde @src/cart.ts ");
    expect(insertMention("lis", { kind: "folder", path: "src" })).toBe("lis @src/ ");
  });

  it("extracts files, folders and URLs, ignores invalid paths and e-mails", () => {
    const text = "Corrige @src/cart.ts, regarde @tests/ et @https://exemple.com/doc. Pas @../secret ni a@b.c ni @src/cart.ts";
    expect(extractMentions(text)).toEqual([
      { kind: "file", path: "src/cart.ts" },
      { kind: "folder", path: "tests" },
      { kind: "url", url: "https://exemple.com/doc" },
    ]);
  });

  it("removes a mention everywhere it appears", () => {
    expect(removeMention("voir @src/a.ts et @src/b.ts puis @src/a.ts.", { kind: "file", path: "src/a.ts" })).toBe("voir et @src/b.ts puis");
  });

  it("proposes matching folders before files, and a typed URL first", () => {
    expect(mentionSuggestions("comp", ["src/components/Button.tsx", "src/components/Card.tsx"])).toEqual([
      { kind: "folder", path: "src/components" },
      { kind: "file", path: "src/components/Button.tsx" },
      { kind: "file", path: "src/components/Card.tsx" },
    ]);
    expect(mentionSuggestions("https://exemple.com", [])).toEqual([{ kind: "url", url: "https://exemple.com/" }]);
  });

  it("estimates tokens as an approximation (4 characters each)", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcde")).toBe(2);
  });
});

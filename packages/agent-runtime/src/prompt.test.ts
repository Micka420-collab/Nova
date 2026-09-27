import type { Message, MessageRole, MessageStatus } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { NOVA_SYSTEM_PROMPT, buildConversationTitle, buildProviderMessages } from "./prompt";

let counter = 0;
function message(role: MessageRole, content: string, status: MessageStatus = "complete"): Message {
  counter += 1;
  return {
    id: `m${counter}`,
    conversationId: "c",
    role,
    content,
    status,
    modelId: null,
    servedModel: null,
    servedProvider: null,
    error: null,
    usage: null,
    createdAt: counter,
    updatedAt: counter,
  };
}

describe("buildConversationTitle", () => {
  it("keeps the first non-blank line with collapsed whitespace", () => {
    expect(buildConversationTitle("  Bonjour   le\tmonde  \nsuite")).toBe("Bonjour le monde");
    expect(buildConversationTitle("\n \r\n  Deuxième ligne\nfin")).toBe("Deuxième ligne");
    expect(buildConversationTitle(" \n\t ")).toBe("Nouvelle conversation");
  });

  it("cuts long lines at a word boundary within 60 characters", () => {
    const title = buildConversationTitle(
      "Peux-tu m'expliquer comment fonctionne la persistance, étape par étape, dans une base SQLite ?",
    );
    // "étape" would overflow; the trailing comma is dropped before the ellipsis.
    expect(title).toBe("Peux-tu m'expliquer comment fonctionne la persistance…");
    // A word ending exactly at the limit is kept whole; one crossing it is dropped.
    expect(buildConversationTitle(`${"a".repeat(59)} suite`)).toBe(`${"a".repeat(59)}…`);
    expect(buildConversationTitle(`${"a".repeat(58)} bcd`)).toBe(`${"a".repeat(58)}…`);
  });

  it("hard-cuts a single long word without splitting characters", () => {
    expect(buildConversationTitle("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
    const emoji = buildConversationTitle("😀".repeat(80));
    expect(Array.from(emoji)).toHaveLength(60);
    expect(emoji.endsWith("😀…")).toBe(true);
  });
});

describe("buildProviderMessages", () => {
  it("prepends the system prompt and keeps only user turns and complete answers", () => {
    const history = [
      message("user", "Q1"),
      message("assistant", "partiel", "error"),
      message("user", "Q2"),
      message("assistant", "coupé", "stopped"),
      message("assistant", "perdu", "interrupted"),
      message("assistant", "   ", "complete"),
      message("user", "Q3"),
      message("assistant", "R3"),
      message("user", "Q4"),
      message("assistant", "", "streaming"),
    ];
    expect(buildProviderMessages(history)).toEqual([
      { role: "system", content: NOVA_SYSTEM_PROMPT },
      { role: "user", content: "Q1" },
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "assistant", content: "R3" },
      { role: "user", content: "Q4" },
    ]);
  });

  it("keeps the most recent messages within the budget", () => {
    const history = [
      message("user", "a".repeat(10)),
      message("assistant", "b".repeat(10)),
      message("user", "c".repeat(10)),
      message("assistant", "d".repeat(10)),
      message("user", "e".repeat(10)),
    ];
    const contents = (maxChars: number) =>
      buildProviderMessages(history, { maxChars })
        .slice(1)
        .map((m) => m.content[0]);
    expect(contents(50)).toEqual(["a", "b", "c", "d", "e"]);
    expect(contents(35)).toEqual(["c", "d", "e"]);
    // "b" fits but would open the window on an answer whose question was dropped.
    expect(contents(40)).toEqual(["c", "d", "e"]);
  });

  it("always keeps the latest user message, even alone over budget", () => {
    const history = [message("user", "court"), message("assistant", "R"), message("user", "x".repeat(500))];
    expect(buildProviderMessages(history, { maxChars: 100 })).toEqual([
      { role: "system", content: NOVA_SYSTEM_PROMPT },
      { role: "user", content: "x".repeat(500) },
    ]);
  });
});

describe("buildMissionSystemPrompt", () => {
  it("names only the tools sent and states what the mode cannot do", async () => {
    const { buildMissionSystemPrompt } = await import("./prompt");
    const understand = buildMissionSystemPrompt({ mode: "understand", toolNames: ["read_file", "search_text"], webSearch: false });
    expect(understand).toContain("Outils disponibles : read_file, search_text. Tu n'en as pas d'autres.");
    expect(understand).toContain("tu ne modifies aucun fichier");
    expect(understand).toContain("Tu n'as pas accès à Internet.");
    expect(understand).not.toContain("edit_file");
    expect(understand).not.toContain("sans shell");

    const fix = buildMissionSystemPrompt({ mode: "fix", toolNames: ["read_file", "run_command", "web_search", "fetch_page"], webSearch: true });
    expect(fix).toContain("sans shell");
    expect(fix).toContain("cite les URL");
    expect(buildMissionSystemPrompt({ mode: "discuss", toolNames: [], webSearch: false })).toContain("Tu n'as aucun outil");
  });
});

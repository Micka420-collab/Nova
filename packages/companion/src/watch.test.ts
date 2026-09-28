import { describe, expect, it } from "vitest";
import { dropIntents } from "./drop";
import { planModelExplanation, explainLocally } from "./explain";
import { buildNomiMenu, NOMI_PALETTE_COMMANDS, type NomiMenuFacts } from "./menu";
import { signalFromProcessExit } from "./signals";
import { parseTestCounts, summarizeProcessExit } from "./watch";

const VITEST = ` FAIL  src/cart.test.ts > cart > total
 Test Files  1 failed | 7 passed (8)
      Tests  1 failed | 41 passed (42)
   Duration  1.2s`;
const JEST = `FAIL src/cart.test.ts
Tests:       1 failed, 41 passed, 42 total`;
const PYTEST = "FAILED tests/test_cart.py::test_total - assert 2 == 3\n===== 1 failed, 41 passed in 0.52s =====";

describe("P5 watched command report", () => {
  it.each([
    ["vitest", VITEST],
    ["jest", JEST],
    ["pytest", PYTEST],
  ])("reads real counts from %s output", (_runner, output) => {
    const counts = parseTestCounts(output);
    expect(counts).toMatchObject({ passed: 41, failed: 1 });
    expect(counts?.firstFailure).toMatch(/cart/);
  });

  it("reports counts from the output and success only from the exit code", () => {
    expect(summarizeProcessExit({ exitCode: 1, signal: null, outputTail: VITEST })).toEqual({
      text: "Tests terminés : 41 réussis, 1 échoué (cart.test.ts).",
      ok: false,
      tests: { passed: 41, failed: 1, firstFailure: "cart.test.ts" },
    });
  });

  it("an unknown format gives « Commande terminée, code 0 » without counting", () => {
    expect(summarizeProcessExit({ exitCode: 0, signal: null, outputTail: "built in 3s" })).toEqual({
      text: "Commande terminée, code 0.",
      ok: true,
      tests: null,
    });
    expect(summarizeProcessExit({ exitCode: null, signal: "SIGTERM", outputTail: "" }).text).toBe("Commande interrompue (SIGTERM).");
  });

  it("a watched exit ≠ 0 becomes a signal; exit 0 does not", () => {
    const exit = { sessionId: "s1", workspaceId: null, exitCode: 1, signal: null, outputTail: VITEST };
    expect(signalFromProcessExit(exit, "w1")?.draft.kind).toBe("test_failed");
    expect(signalFromProcessExit({ ...exit, outputTail: "segfault" }, "w2")?.draft.kind).toBe("process_crashed");
    expect(signalFromProcessExit({ ...exit, exitCode: 0 }, "w3")).toBeNull();
  });
});

describe("P3 explain: local first, model on demand with cost", () => {
  it("explains a tool error from the normalized code, without any network", () => {
    expect(explainLocally({ kind: "tool", code: "outside_workspace", message: null })).toMatchObject({
      what: "Le chemin est hors de l'espace de travail.",
      why: "NOVA n'agit que dans le dossier ouvert.",
    });
  });

  it("shows what would be sent and its estimated cost; redacts secrets; unknown price stays unknown", () => {
    const explanation = explainLocally({ kind: "command", argv: ["pnpm", "test"], exitCode: 1, signal: null, outputTail: "Error: key sk-or-v1-abcdefghijkl" });
    const context = { path: "src/server.ts", line: 42, command: ["pnpm", "test"], text: "x".repeat(10_000) };
    const priced = planModelExplanation(explanation, context, { name: "DeepSeek", pricing: { promptPerMTok: 1, completionPerMTok: 2, variable: false } });
    expect(priced.prompt).not.toContain("sk-or-v1");
    expect(priced.prompt).toContain("Fichier : src/server.ts, ligne 42");
    expect(priced.contextChars).toBeLessThanOrEqual(8_000 + 2_000);
    expect(priced.cost?.maxUsd).toBeGreaterThan(priced.cost?.minUsd ?? Infinity);
    expect(priced.disclosure).toMatch(/^Cette action enverra l'erreur et \d+ caractères de contexte à DeepSeek\.$/);
    const unknown = planModelExplanation(explanation, context, { name: "X", pricing: { promptPerMTok: null, completionPerMTok: 2, variable: false } });
    expect(unknown.cost).toBeNull();
    expect(unknown.costLabel).toBe("Coût estimé : inconnu (prix du modèle non publié)");
  });
});

describe("P10 drop intents", () => {
  it("offers only what is really possible", () => {
    expect(dropIntents({ name: "a.ts", size: 36 * 1024, mimeType: "", isDirectory: false }, { imageInput: null })).toEqual([
      { kind: "attach_text", label: "Joindre à la conversation", disclosure: "Cette action enverra 36 Ko au fournisseur choisi." },
    ]);
    const image = { name: "a.png", size: 10, mimeType: "image/png", isDirectory: false };
    expect(dropIntents(image, { imageInput: false })).toEqual([
      { kind: "choose_model", label: "Choisir un modèle compatible", reason: "Ce modèle ne lit pas les images" },
    ]);
    expect(dropIntents(image, { imageInput: true })[0]?.kind).toBe("refused");
    expect(dropIntents({ name: "dir", size: 0, mimeType: "", isDirectory: true }, { imageInput: null })[0]?.kind).toBe("open_workspace");
    expect(dropIntents({ name: "big.log", size: 200_000, mimeType: "", isDirectory: false }, { imageInput: null })[0]?.kind).toBe("refused");
    expect(dropIntents({ name: "a.zip", size: 1, mimeType: "application/zip", isDirectory: false }, { imageInput: null })[0]?.kind).toBe("refused");
  });
});

describe("P9 menu", () => {
  const base: NomiMenuFacts = { mission: null, pendingApprovals: [], recentError: null, unwatchedSessionId: null, quietUntil: null, now: 0 };

  it("without facts, only quiet mode and settings", () => {
    expect(buildNomiMenu(base).map((entry) => entry.id)).toEqual(["nomi.quiet", "nomi.settings"]);
  });

  it("each fact adds exactly its entry, and every entry is also a palette command", () => {
    const menu = buildNomiMenu({
      ...base,
      recentError: { kind: "ref", sourceRef: { kind: "terminal", sessionId: "s" } },
      unwatchedSessionId: "s2",
      quietUntil: 10,
    });
    expect(menu.map((entry) => entry.id)).toEqual(["nomi.explainError", "nomi.watchCommand", "nomi.quiet", "nomi.settings"]);
    expect(menu.find((entry) => entry.id === "nomi.quiet")?.label).toBe("Quitter le mode discret");
    const palette = new Set(NOMI_PALETTE_COMMANDS.map((command) => command.id));
    for (const entry of menu) expect(palette.has(entry.id)).toBe(true);
  });
});

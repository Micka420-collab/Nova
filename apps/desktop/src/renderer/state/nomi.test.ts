import { describe, expect, it } from "vitest";
import type { ProviderConnectionView } from "@nova/shared";
import { ABSENT_CONNECTION, VALID_CONNECTION } from "../test/fake-bridge";
import { deriveNomiState, OUTCOME_WINDOW_MS, type NomiInput } from "./nomi";

const NOW = 1_000_000;
const verified: ProviderConnectionView = { ...VALID_CONNECTION, lastCheckedAt: NOW - 5 * 60_000 };
const base: NomiInput = { online: true, connection: verified, activeStreamPhase: null, lastOutcome: null, now: NOW };

describe("deriveNomiState", () => {
  it.each<[string, Partial<NomiInput>, string, string]>([
    ["connection not read yet", { connection: null }, "offline", "Démarrage"],
    ["no key", { connection: ABSENT_CONNECTION }, "offline", "Pas encore connecté"],
    ["rejected key", { connection: { ...verified, state: "invalid" } }, "error", "Clé refusée"],
    ["browser offline", { online: false }, "offline", "Hors ligne"],
    ["request sent", { activeStreamPhase: "waiting" }, "thinking", "Nomi réfléchit…"],
    ["model reasoning", { activeStreamPhase: "reasoning" }, "thinking", "Nomi réfléchit…"],
    ["text arriving", { activeStreamPhase: "writing" }, "working", "Nomi écrit…"],
    ["answer just completed", { lastOutcome: { kind: "success", at: NOW - 1000 } }, "success", "Réponse terminée"],
    ["answer just failed", { lastOutcome: { kind: "error", at: NOW - 1000 } }, "error", "Quelque chose a échoué"],
    ["generation just stopped", { lastOutcome: { kind: "stopped", at: NOW - 1000 } }, "idle", "Génération arrêtée"],
    ["nothing going on", {}, "idle", "Nomi est disponible"],
  ])("%s", (_case, input, state, label) => {
    const view = deriveNomiState({ ...base, ...input });
    expect(view.state).toBe(state);
    expect(view.label).toBe(label);
    expect(view.detail.length).toBeGreaterThan(0);
  });

  it("gives an actionable detail when the key is missing or rejected", () => {
    expect(deriveNomiState({ ...base, connection: ABSENT_CONNECTION }).detail).toMatch(/Ajoute une clé OpenRouter/);
    expect(deriveNomiState({ ...base, connection: { ...verified, state: "invalid" } }).detail).toMatch(/remplace-la/);
  });

  it("a missing key wins over a running stream and the network state", () => {
    const view = deriveNomiState({ ...base, connection: ABSENT_CONNECTION, online: false, activeStreamPhase: "writing" });
    expect(view.label).toBe("Pas encore connecté");
  });

  it("says when the key was verified, or that it is not", () => {
    expect(deriveNomiState(base).detail).toBe("Connecté à OpenRouter · clé vérifiée il y a 5 minutes");
    expect(deriveNomiState({ ...base, connection: { ...verified, state: "unverified" } }).detail).toBe("Clé non vérifiée");
  });

  it("an outcome older than the window falls back to idle; a live stream beats a recent outcome", () => {
    const old = { kind: "success" as const, at: NOW - OUTCOME_WINDOW_MS };
    expect(deriveNomiState({ ...base, lastOutcome: old }).state).toBe("idle");
    const recent = { kind: "error" as const, at: NOW - 100 };
    expect(deriveNomiState({ ...base, lastOutcome: recent, activeStreamPhase: "waiting" }).state).toBe("thinking");
  });
});

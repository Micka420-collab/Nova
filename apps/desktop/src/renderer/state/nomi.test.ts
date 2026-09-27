import { describe, expect, it } from "vitest";
import { EMPTY_COMPANION_FACTS, currentActivity, focusMission, reduceCompanionFacts } from "@nova/companion";
import type { ProviderConnectionView } from "@nova/shared";
import { MissionLog, approval, testsDisplay } from "@nova/companion/testing";
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

  it("names the conversation that failed when it is not the one on screen", () => {
    const failed = { kind: "error" as const, at: NOW - 100 };
    expect(deriveNomiState({ ...base, lastOutcome: failed }).detail).toBe("Le détail est affiché sous le message.");
    expect(deriveNomiState({ ...base, lastOutcome: failed, outcomeElsewhere: "Plan de voyage" }).detail).toBe(
      "« Plan de voyage » a échoué.",
    );
  });

  it("an outcome older than the window falls back to idle; a live stream beats a recent outcome", () => {
    const old = { kind: "success" as const, at: NOW - OUTCOME_WINDOW_MS };
    expect(deriveNomiState({ ...base, lastOutcome: old }).state).toBe("idle");
    const recent = { kind: "error" as const, at: NOW - 100 };
    expect(deriveNomiState({ ...base, lastOutcome: recent, activeStreamPhase: "waiting" }).state).toBe("thinking");
  });
});

describe("deriveNomiState with missions and activities (NOMI.md §6)", () => {
  const log = () => new MissionLog().created("Facturation").started();
  const factsOf = (l: MissionLog) => l.events.reduce(reduceCompanionFacts, EMPTY_COMPANION_FACTS);
  const derive = (l: MissionLog, extra: Partial<NomiInput> = {}) => {
    const mission = focusMission(factsOf(l));
    return deriveNomiState({ ...base, mission, activity: currentActivity(mission), ...extra });
  };

  it.each<[string, (l: MissionLog) => void, string, string]>([
    ["read_file running → thinking, reading", (l) => l.tool("c", "read_file"), "thinking", "reading"],
    ["search_text running → thinking, searching", (l) => l.tool("c", "search_text"), "thinking", "searching"],
    ["edit_file running → working, editing", (l) => l.tool("c", "edit_file"), "working", "editing"],
    ["run_command running → working, running", (l) => l.tool("c", "run_command"), "working", "running"],
    ["run_tests running → working, testing", (l) => l.tool("c", "run_tests"), "working", "testing"],
    [
      "read after a failed test → thinking, debugging",
      (l) => l.tool("t", "run_tests").finished("t", testsDisplay(1, 1, 1), "failed").tool("r", "read_file"),
      "thinking",
      "debugging",
    ],
    ["tool finished → back to thinking, no accessory", (l) => l.tool("c", "edit_file").finished("c", { kind: "text", text: "" }), "thinking", "none"],
  ])("%s", (_name, act, state, activity) => {
    const l = log();
    act(l);
    const view = derive(l);
    expect(view.state).toBe(state);
    expect(view.activity).toBe(activity);
    expect(view.detail).toBe("Facturation");
  });

  it("an approval wins over a running tool and a live stream: waiting, with the count", () => {
    const l = log().tool("c", "edit_file");
    l.add("approval.requested", { approval: approval("a1") });
    const view = derive(l, { activeStreamPhase: "writing" });
    expect(view).toMatchObject({ state: "waiting", waiting: "active", label: "Nomi attend ta réponse", detail: "1 approbation en attente" });
  });

  it("a budget suspension is a still wait with its own label", () => {
    const l = log();
    l.add("mission.suspended", { reason: "budget", detail: null });
    expect(derive(l)).toMatchObject({ state: "waiting", waiting: "suspended", label: "Mission suspendue : plafond atteint" });
  });

  it("a mission end shows success or error for the outcome window, then idle", () => {
    const at = NOW - 1000;
    expect(deriveNomiState({ ...base, missionOutcome: { kind: "success", at, title: "Facturation" } })).toMatchObject({
      state: "success",
      label: "Mission terminée",
      detail: "Facturation",
    });
    expect(deriveNomiState({ ...base, missionOutcome: { kind: "error", at, title: null } }).state).toBe("error");
    expect(deriveNomiState({ ...base, missionOutcome: { kind: "success", at: NOW - OUTCOME_WINDOW_MS, title: null } }).state).toBe("idle");
  });

  it("quiet mode is an idle pose flagged quiet, until its end", () => {
    const view = deriveNomiState({ ...base, quietUntil: NOW + 60_000 });
    expect(view).toMatchObject({ state: "idle", quiet: true });
    expect(view.label).toMatch(/^Nomi est en mode discret jusqu'à \d+ h \d{2}$/);
    expect(deriveNomiState({ ...base, quietUntil: NOW - 1 }).quiet).toBe(false);
  });

  it("without a mission nothing changes: no accessory, never a fake activity", () => {
    expect(deriveNomiState({ ...base, activity: "editing" })).toMatchObject({ state: "idle", activity: "none" });
  });
});

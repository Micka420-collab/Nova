import { describe, expect, it } from "vitest";
import type { Schedule, ScheduleRun } from "@nova/shared";
import { describeRun, describeTrigger } from "./schedule-format";
import { draftFromSchedule, emptyScheduleDraft, previewRuns, validateScheduleDraft } from "./schedule-form";

const NOW = Date.parse("2026-06-12T16:40:00Z");

const draft = (patch: Partial<ReturnType<typeof emptyScheduleDraft>> = {}) => ({
  ...emptyScheduleDraft({ modelId: "vendor/model", now: NOW, timeZone: "Europe/Paris" }),
  title: "Tests du matin",
  goal: "Lance les tests et résume ce qui casse",
  ...patch,
});

describe("schedule editor model", () => {
  it("previews the same next runs main computes (cron in the schedule's zone)", () => {
    const runs = previewRuns(draft({ kind: "cron", cron: "*/15   9-18 * * 1-5" }), NOW, 3);
    expect(runs.map((value) => new Date(value).toISOString())).toEqual([
      "2026-06-12T16:45:00.000Z",
      "2026-06-15T07:00:00.000Z",
      "2026-06-15T07:15:00.000Z",
    ]);
  });

  it("validates into a create payload with a contract derived from the profile", () => {
    const result = validateScheduleDraft(draft({ kind: "weekly", days: [4, 1, 1], time: "08:15", budgetUsd: "0,25", durationMinutes: "20", profile: "read_only" }), NOW);
    expect(result).toEqual({
      ok: true,
      fields: {
        title: "Tests du matin",
        goal: "Lance les tests et résume ce qui casse",
        mode: "verify",
        modelId: "vendor/model",
        trigger: { kind: "weekly", days: [1, 4], time: "08:15", timeZone: "Europe/Paris" },
        missedPolicy: "skip",
        contract: { profile: "read_only", allowedOperations: ["read", "network"], allowedHosts: [], webSearch: false, maxDurationMs: 20 * 60_000, budgetUsd: 0.25 },
      },
    });
  });

  it("names each problem next to its field", () => {
    const result = validateScheduleDraft(
      draft({ title: " ", kind: "cron", cron: "61 * * * *", budgetUsd: "beaucoup", durationMinutes: "0", modelId: "" }),
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        title: "Donne un nom (120 caractères au plus).",
        model: "Choisis un modèle.",
        trigger: "Expression cron invalide : minute: 61 is outside 0-59.",
        budget: "Un montant entre 0 et 1 000.",
        duration: "Entre 1 et 1 440 minutes.",
      },
    });
    expect(validateScheduleDraft(draft({ kind: "daily", timeZone: "Mars/Olympus" }), NOW)).toMatchObject({ ok: false, errors: { timeZone: "Fuseau horaire inconnu." } });
    expect(validateScheduleDraft(draft({ kind: "once", onceAt: "2026-06-12T10:00" }), NOW)).toMatchObject({ ok: false, errors: { trigger: expect.stringMatching(/à venir/) } });
    expect(validateScheduleDraft(draft({ kind: "interval", everyMinutes: "0" }), NOW)).toMatchObject({ ok: false, errors: { trigger: expect.stringMatching(/Au moins 1 minute/) } });
    expect(validateScheduleDraft(draft({ kind: "weekly", days: [] }), NOW)).toMatchObject({ ok: false, errors: { trigger: "Choisis au moins un jour." } });
  });

  it("editing keeps the contract's other options unless the profile changes", () => {
    const schedule: Schedule = {
      id: "s",
      workspaceId: "w",
      title: "Revue",
      goal: "Relis le diff",
      mode: "understand",
      modelId: "vendor/model",
      contract: {
        profile: "assisted",
        allowedOperations: ["read"],
        allowedHosts: ["npmjs.com"],
        webSearch: true,
        maxDurationMs: 30 * 60_000,
        budgetUsd: 1.5,
        harness: { chain: true, autoContinue: null, subMissions: null },
      },
      trigger: { kind: "interval", everyMinutes: 90 },
      missedPolicy: "run_once",
      state: "active",
      nextRunAt: null,
      lastRunAt: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const kept = validateScheduleDraft(draftFromSchedule(schedule, NOW), NOW);
    expect(kept).toMatchObject({ ok: true, fields: { contract: schedule.contract, trigger: schedule.trigger, missedPolicy: "run_once" } });
    const widened = validateScheduleDraft({ ...draftFromSchedule(schedule, NOW), profile: "autonomous" }, NOW);
    expect(widened.ok && widened.fields.contract.allowedOperations).toContain("write");
  });
});

describe("schedule descriptions", () => {
  it("describes triggers in French and names a foreign zone", () => {
    expect(describeTrigger({ kind: "interval", everyMinutes: 1 }, "Europe/Paris")).toBe("Toutes les minutes");
    expect(describeTrigger({ kind: "interval", everyMinutes: 120 }, "Europe/Paris")).toBe("Toutes les 2 heures");
    expect(describeTrigger({ kind: "daily", time: "09:00", timeZone: "Europe/Paris" }, "Europe/Paris")).toBe("Chaque jour à 09:00");
    expect(describeTrigger({ kind: "weekly", days: [0, 1, 4], time: "08:15", timeZone: "America/New_York" }, "Europe/Paris")).toBe(
      "Chaque lundi, jeudi et dimanche à 08:15 (heures du fuseau America/New_York)",
    );
  });

  it("explains a run's outcome without showing raw codes", () => {
    const run = (outcome: ScheduleRun["outcome"], detail: string | null): ScheduleRun => ({
      id: "r",
      scheduleId: "s",
      missionId: null,
      dueAt: 0,
      startedAt: null,
      endedAt: null,
      outcome,
      detail,
    });
    expect(describeRun(run("skipped_missed", "nova_closed"))).toBe("Manquée : NOVA était fermé");
    expect(describeRun(run("error", "start_failed:no_key"))).toBe("N’a pas pu démarrer : aucune clé de fournisseur");
    expect(describeRun(run("error", "start_failed:weird"))).toBe("N’a pas pu démarrer : erreur interne");
    expect(describeRun(run("skipped_overlap", "previous_run_active"))).toBe("Sautée : l’exécution précédente n’était pas finie");
    expect(describeRun(run("running", "catch_up"))).toBe("En cours : rattrapage au démarrage");
  });
});

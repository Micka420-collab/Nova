import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaIpcError, type Schedule, type ScheduleEvent, type ScheduleRun } from "@nova/shared";
import { createSchedulesStore } from "../../state/schedules-slice";
import { SchedulesManager, type SchedulesApi } from "./SchedulesManager";

const WS = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-06-10T08:00:00Z");

const schedule = (id: string, over: Partial<Schedule> = {}): Schedule => ({
  id,
  workspaceId: WS,
  title: "Tests du matin",
  goal: "Lance les tests",
  mode: "verify",
  modelId: "vendor/tools",
  contract: { profile: "assisted", allowedOperations: ["read"], allowedHosts: [], webSearch: false, maxDurationMs: 900_000, budgetUsd: 0.5 },
  trigger: { kind: "interval", everyMinutes: 60 },
  missedPolicy: "skip",
  state: "active",
  nextRunAt: NOW + 3_600_000,
  lastRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const run = (id: string, over: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id,
  scheduleId: "s1",
  missionId: "m1",
  dueAt: NOW - 3_600_000,
  startedAt: NOW - 3_600_000,
  endedAt: null,
  outcome: "running",
  detail: null,
  ...over,
});

function setup(list: () => Promise<Schedule[]>, overrides: Partial<SchedulesApi> = {}) {
  let emit: ((event: ScheduleEvent) => void) | null = null;
  const api = {
    list: vi.fn<SchedulesApi["list"]>(list),
    create: vi.fn<SchedulesApi["create"]>(async (req) => schedule("s-new", { ...req, nextRunAt: NOW + 60_000, createdAt: 5 })),
    update: vi.fn<SchedulesApi["update"]>(async ({ scheduleId, patch }) => schedule(scheduleId, patch)),
    setPaused: vi.fn<SchedulesApi["setPaused"]>(async ({ scheduleId, paused }) =>
      schedule(scheduleId, paused ? { state: "paused", nextRunAt: null } : { state: "active" }),
    ),
    remove: vi.fn<SchedulesApi["remove"]>(async () => undefined),
    runs: vi.fn<SchedulesApi["runs"]>(async () => [run("r1")]),
    onEvent: vi.fn<SchedulesApi["onEvent"]>((listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    }),
    ...overrides,
  };
  const store = createSchedulesStore();
  const opened: string[] = [];
  render(
    <SchedulesManager
      api={api}
      store={store}
      workspaceId={WS}
      models={[
        { id: "vendor/tools", name: "Vendor Tools", supportsTools: true },
        { id: "vendor/chat-only", name: "Vendor Chat", supportsTools: false },
      ]}
      defaultModelId="vendor/tools"
      onOpenMission={(id) => opened.push(id)}
      now={() => NOW}
    />,
  );
  return { api, store, opened, emit: (event: ScheduleEvent) => emit?.(event) };
}

afterEach(cleanup);

describe("SchedulesManager", () => {
  it("renders nothing while the group is unavailable", async () => {
    const { store } = setup(async () => {
      throw new NovaIpcError({ code: "unavailable", message: "schedules.list is not available yet" });
    });
    await waitFor(() => expect(store.getState().status).toBe("unavailable"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("lists the project's schedules, says they run only while NOVA is open, pauses and resumes", async () => {
    const { api } = setup(async () => [schedule("s1")]);
    expect(await screen.findByText("Tests du matin")).toBeTruthy();
    expect(api.list).toHaveBeenCalledWith({ workspaceId: WS });
    expect(screen.getByText(/tournent seulement quand NOVA est ouvert/)).toBeTruthy();
    expect(screen.getByText("Toutes les heures")).toBeTruthy();
    expect(screen.getByText(/Pas encore exécutée/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mettre en pause Tests du matin" }));
    await waitFor(() => expect(api.setPaused).toHaveBeenCalledWith({ scheduleId: "s1", paused: true }));
    expect(await screen.findByText("En pause")).toBeTruthy();
    expect(screen.getByText(/Aucune exécution à venir/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("« Tests du matin » est en pause : aucune nouvelle exécution.");

    fireEvent.click(screen.getByRole("button", { name: "Reprendre Tests du matin" }));
    expect(await screen.findByText("Active")).toBeTruthy();
  });

  it("creates a schedule from the editor with a preview of the next runs; tool-less models are not offered", async () => {
    const { api } = setup(async () => []);
    expect(await screen.findByText("Aucune mission planifiée")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nouvelle planification" }));
    const form = screen.getByRole("form", { name: "Nouvelle planification" });
    expect(within(form).queryByRole("option", { name: "Vendor Chat" })).toBeNull();

    // Nothing is sent while a field is invalid; the reason is shown.
    fireEvent.click(within(form).getByRole("button", { name: "Enregistrer" }));
    expect(await within(form).findByText("Donne un nom (120 caractères au plus).")).toBeTruthy();
    expect(api.create).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText("Nom"), { target: { value: "Veille" } });
    fireEvent.change(within(form).getByLabelText(/Objectif de la mission/), { target: { value: "Relis les dépendances" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Intervalle" }));
    fireEvent.change(within(form).getByLabelText("Toutes les (minutes)"), { target: { value: "30" } });
    const preview = within(form).getByRole("region", { name: "Prochaines exécutions" });
    expect(within(preview).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(within(form).getByRole("radio", { name: /Rattraper une seule fois/ }));

    fireEvent.click(within(form).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.create).mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WS,
      title: "Veille",
      goal: "Relis les dépendances",
      modelId: "vendor/tools",
      trigger: { kind: "interval", everyMinutes: 30 },
      missedPolicy: "run_once",
      contract: { profile: "assisted", budgetUsd: 0.5 },
    });
    expect(await screen.findByText("Veille")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("« Veille » est enregistrée.");
  });

  it("shows the run history with reasons, follows pushed runs and opens a run's mission", async () => {
    const { api, emit, opened } = setup(async () => [schedule("s1")], {
      runs: vi.fn<SchedulesApi["runs"]>(async () => [
        run("r2", { missionId: null, dueAt: NOW, outcome: "skipped_overlap", detail: "previous_run_active" }),
        run("r1"),
      ]),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Historique de Tests du matin" }));
    expect(await screen.findByText("Sautée : l’exécution précédente n’était pas finie")).toBeTruthy();
    expect(api.runs).toHaveBeenCalledWith({ scheduleId: "s1", limit: 50 });
    act(() => emit({ type: "schedule.run", run: run("r1", { outcome: "succeeded", endedAt: NOW }) }));
    expect(await screen.findByText("Réussie")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la mission" }));
    expect(opened).toEqual(["m1"]);
  });

  it("removes after confirmation, and shows a refused action in the row", async () => {
    const { api } = setup(async () => [schedule("s1"), schedule("s2", { title: "Terminé", state: "completed", nextRunAt: null, createdAt: 2 })], {
      update: vi.fn<SchedulesApi["update"]>(async () => {
        throw new NovaIpcError({ code: "not_found", message: "Schedule not found" });
      }),
    });
    await screen.findByText("Terminé");
    // A completed schedule offers no pause.
    expect(screen.queryByRole("button", { name: "Mettre en pause Terminé" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Supprimer Tests du matin" }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Supprimer définitivement" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ scheduleId: "s1" }));
    await waitFor(() => expect(screen.queryByText("Tests du matin")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Modifier Terminé" }));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(await screen.findByText(/Cette planification n’existe plus/)).toBeTruthy();
    expect(screen.queryByText(/Schedule not found/)).toBeNull();
  });
});

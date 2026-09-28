import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaIpcError, type MissionProcess, type ProcessEvent } from "@nova/shared";
import { createProcessesStore } from "../../state/processes-slice";
import { MissionProcesses, type ProcessesApi } from "./MissionProcesses";

const MISSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const proc = (id: string, over: Partial<MissionProcess> = {}): MissionProcess => ({
  id,
  missionId: MISSION,
  workspaceId: "w",
  argv: ["pnpm", "dev"],
  cwd: "web",
  pid: 4242,
  state: "running",
  exitCode: null,
  signal: null,
  startedAt: 1,
  endedAt: null,
  terminalSessionId: "session-1",
  outputChars: 10,
  ...over,
});

function setup(list: () => Promise<MissionProcess[]>, overrides: Partial<ProcessesApi> = {}) {
  let emit: ((event: ProcessEvent) => void) | null = null;
  const api = {
    list: vi.fn<ProcessesApi["list"]>(list),
    output: vi.fn<ProcessesApi["output"]>(async ({ processId }) => ({ processId, state: "running", text: "ready on :5173", truncated: true, totalChars: 90_000 })),
    stop: vi.fn<ProcessesApi["stop"]>(async ({ processId }) => proc(processId, { state: "stopped", endedAt: 9, signal: "SIGTERM" })),
    onEvent: vi.fn<ProcessesApi["onEvent"]>((listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    }),
    ...overrides,
  };
  const store = createProcessesStore();
  const shown: string[] = [];
  render(<MissionProcesses api={api} store={store} missionId={MISSION} onShowTerminal={(id) => shown.push(id)} />);
  return { api, store, shown, emit: (event: ProcessEvent) => emit?.(event) };
}

afterEach(cleanup);

describe("MissionProcesses", () => {
  it("lists the mission's processes, stops one (visible result) and opens its terminal", async () => {
    const { api, shown } = setup(async () => [proc("p1"), proc("p2", { argv: ["node", "worker.js"], state: "exited", exitCode: 1, endedAt: 3, terminalSessionId: null })]);
    expect(await screen.findByText("pnpm dev")).toBeTruthy();
    expect(api.list).toHaveBeenCalledWith({ workspaceId: null, missionId: MISSION });
    expect(screen.getByText("Échec · code 1")).toBeTruthy();
    expect(screen.getByText("1 en cours sur 2")).toBeTruthy();
    expect(screen.getAllByText("dossier : web · PID 4242")).toHaveLength(2);
    // Only the running process can be stopped; only a hosted one has a terminal.
    expect(screen.getAllByRole("button", { name: /^Arrêter/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Voir le terminal" }));
    expect(shown).toEqual(["session-1"]);

    fireEvent.click(screen.getByRole("button", { name: "Arrêter pnpm dev" }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith({ processId: "p1" }));
    expect(await screen.findByText("Arrêté")).toBeTruthy();
    expect(screen.getByText("pnpm dev est arrêté.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Arrêter/ })).toBeNull();
  });

  it("shows the latest output on demand, says when it was cut, and shows a failed stop in the row", async () => {
    const { api } = setup(async () => [proc("p1")], {
      stop: vi.fn<ProcessesApi["stop"]>(async () => {
        throw new NovaIpcError({ code: "not_found", message: "Process not found" });
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Voir la sortie" }));
    expect(await screen.findByText("ready on :5173")).toBeTruthy();
    expect(api.output).toHaveBeenCalledWith({ processId: "p1", maxChars: 4_000 });
    expect(screen.getByText("Les 14 derniers caractères sur 90000.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Arrêter pnpm dev" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Ce processus n’existe plus (NOVA a pu redémarrer).");
    // The developer message never reaches the UI.
    expect(screen.queryByText(/Process not found/)).toBeNull();
  });

  it("follows pushed events of its mission only", async () => {
    const { emit } = setup(async () => [proc("p1")]);
    await screen.findByText("pnpm dev");
    act(() => emit({ type: "process.started", process: proc("p9", { missionId: OTHER, argv: ["other", "mission"] }) }));
    act(() => emit({ type: "process.ended", process: proc("p1", { state: "exited", exitCode: 0, endedAt: 4 }) }));
    expect(await screen.findByText("Terminé · code 0")).toBeTruthy();
    expect(screen.queryByText("other mission")).toBeNull();
  });

  it("renders nothing while the group is unavailable or when nothing ran in the background", async () => {
    const unavailable = setup(async () => {
      throw new NovaIpcError({ code: "unavailable", message: "processes.list is not available yet" });
    });
    await waitFor(() => expect(unavailable.store.getState().status).toBe("unavailable"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    cleanup();
    const empty = setup(async () => []);
    await waitFor(() => expect(empty.store.getState().status).toBe("ready"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a retry when the list failed", async () => {
    let fail = true;
    const { api } = setup(async () => {
      if (fail) throw new NovaIpcError({ code: "internal", message: "boom" });
      return [proc("p1")];
    });
    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    fail = false;
    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("pnpm dev")).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(3);
  });
});

// L8 UI: no control while main does not serve `timeline.*`; the search shows scoped, redacted
// hits (or says there is none); « Reprendre / Bifurquer d'ici » end with the ready mission or the
// refusal, never silently; the continuation status says why « jusqu'à preuve » stopped.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNovaClient, type MissionForkRequest, type MissionPlanResult, type TimelineHit, type TimelineSearchRequest } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { makeContract } from "../../test/atelier-fake";
import { createFakeBridge, type HarnessOverrides } from "../../test/fake-bridge";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import { initialContinuationView } from "../missions/harness/continuation-view";
import { ContinuationStatus } from "./ContinuationStatus";
import { EventActions } from "./EventActions";
import { TimelineSearch } from "./TimelineSearch";

installDomPolyfills();
afterEach(cleanup);

const M = "00000000-0000-4000-8000-0000000000a1";
const W = "00000000-0000-4000-8000-0000000000b1";
const NEW = "00000000-0000-4000-8000-0000000000a2";
const NOW = 1_000_000_000;

const hit: TimelineHit = { missionId: M, missionTitle: "Panier", seq: 12, type: "mission.failed", at: NOW - 3_600_000, snippet: "Échec du test panier" };

const planResult: MissionPlanResult = {
  mission: {
    id: NEW, workspaceId: W, conversationId: null, title: "Ajoute une remise", goal: "Ajoute une remise", mode: "fix", state: "ready",
    modelId: "vendor/a", createdAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
  },
  contract: makeContract(W),
  tasks: [],
  summary: "",
  estimate: { minUsd: null, maxUsd: null, assumptions: "" },
};

function renderWith(harness: HarnessOverrides, ui: React.ReactNode) {
  const fake = createFakeBridge({ harness });
  const client = createNovaClient(fake.bridge);
  return render(
    <AppProvider store={createAppStore(client)} client={client}>
      {ui}
    </AppProvider>,
  );
}

describe("TimelineSearch", () => {
  it("shows nothing while the group answers unavailable", async () => {
    const { container } = renderWith({}, <TimelineSearch workspaceId={W} missionId={M} onOpen={() => {}} />);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("searches this mission by default, lists hits and opens one", async () => {
    const requests: TimelineSearchRequest[] = [];
    const onOpen = vi.fn<(hit: TimelineHit) => void>();
    renderWith(
      { timeline: { search: async (request) => (requests.push(request), { ok: true, value: request.query === "nova" ? [] : [hit] }) } },
      <TimelineSearch workspaceId={W} missionId={M} onOpen={onOpen} now={() => NOW} />,
    );
    const input = await screen.findByLabelText("Rechercher dans les missions");
    fireEvent.change(input, { target: { value: "panier" } });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher" }));
    await screen.findByText("Échec du test panier");
    expect(requests.at(-1)).toEqual({ query: "panier", workspaceId: W, missionId: M, limit: 50 });
    expect(screen.getByText(/Mission échouée · événement n° 12/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir : Panier, événement n° 12" }));
    expect(onOpen).toHaveBeenCalledWith(hit);

    // Changing the scope re-runs the query on the whole project.
    fireEvent.click(screen.getByRole("radio", { name: "Ce projet" }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ query: "panier", workspaceId: W, missionId: null, limit: 50 }));
  });

  it("says when nothing matches", async () => {
    renderWith({ timeline: { search: async () => ({ ok: true, value: [] }) } }, <TimelineSearch workspaceId={null} missionId={null} onOpen={() => {}} />);
    const input = await screen.findByLabelText("Rechercher dans les missions");
    expect((screen.getByRole("radio", { name: "Cette mission" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "introuvable" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(await screen.findByText("Aucun événement ne contient « introuvable ».")).toBeTruthy();
  });
});

describe("EventActions", () => {
  it("prepares a branch with a new goal and offers its plan", async () => {
    const forks: MissionForkRequest[] = [];
    const onReady = vi.fn<(result: MissionPlanResult) => void>();
    renderWith(
      {
        timeline: {
          search: async () => ({ ok: true, value: [] }),
          fork: async (request) => (forks.push(request), { ok: true, value: planResult }),
        },
      },
      <EventActions missionId={M} seq={7} onReady={onReady} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Bifurquer d’ici" }));
    expect(screen.getByText(/Rien n’est rejoué/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Nouvel objectif/), { target: { value: "Ajoute une remise" } });
    fireEvent.click(screen.getByRole("button", { name: "Préparer la mission" }));
    expect(await screen.findByText(/Mission prête : « Ajoute une remise »/)).toBeTruthy();
    expect(forks).toEqual([{ missionId: M, atSeq: 7, goal: "Ajoute une remise", modelId: null }]);
    fireEvent.click(screen.getByRole("button", { name: "Voir le plan" }));
    expect(onReady).toHaveBeenCalledWith(planResult);
  });

  it("resumes with the original goal and shows a refusal", async () => {
    const forks: MissionForkRequest[] = [];
    renderWith(
      {
        timeline: {
          search: async () => ({ ok: true, value: [] }),
          fork: async (request) => (forks.push(request), { ok: false, error: { code: "invalid_request", message: "seq" } }),
        },
      },
      <EventActions missionId={M} seq={3} onReady={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reprendre d’ici" }));
    expect(screen.queryByLabelText(/Nouvel objectif/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Préparer la mission" }));
    expect(await screen.findByText("La nouvelle mission n’a pas pu être préparée.")).toBeTruthy();
    expect(forks).toEqual([{ missionId: M, atSeq: 3, goal: null, modelId: null }]);
  });

  it("renders nothing for a live event or an unavailable group", async () => {
    const live = renderWith({ timeline: { search: async () => ({ ok: true, value: [] }) } }, <EventActions missionId={M} seq={0} onReady={() => {}} />);
    await act(async () => {});
    expect(live.container.innerHTML).toBe("");
    cleanup();
    const off = renderWith({}, <EventActions missionId={M} seq={4} onReady={() => {}} />);
    await act(async () => {});
    expect(off.container.innerHTML).toBe("");
  });
});

describe("ContinuationStatus", () => {
  it("says why the continuation stopped and where a fork comes from", () => {
    const onOpen = vi.fn<(id: string) => void>();
    render(
      <ContinuationStatus
        onOpenMission={onOpen}
        view={{
          rounds: [
            { seq: 5, round: 1, maxRounds: 3, unprovenTaskIds: ["t1"], at: 5 },
            { seq: 9, round: 2, maxRounds: 3, unprovenTaskIds: ["t1"], at: 9 },
          ],
          stopped: { reason: "proven", rounds: 2, at: 12 },
          forkedFrom: { missionId: M, seq: 4 },
        }}
      />,
    );
    expect(screen.getByText(/Preuve obtenue · 2 tours/)).toBeTruthy();
    expect(screen.getByText(/Bifurquée d’une autre mission, à partir de son événement n° 4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Voir la mission d’origine" }));
    expect(onOpen).toHaveBeenCalledWith(M);
  });

  it("renders nothing without rounds nor origin", () => {
    const { container } = render(<ContinuationStatus view={initialContinuationView()} />);
    expect(container.innerHTML).toBe("");
  });
});

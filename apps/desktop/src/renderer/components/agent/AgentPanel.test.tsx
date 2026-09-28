// What the agent panel says about the mission list: a failed load is never shown as « no mission ».
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installDomPolyfills } from "../../test/dom";
import { renderWithMission } from "../diff/test-helpers";
import { MissionCard } from "../missions/MissionCard";
import { AgentPanel } from "./AgentPanel";

installDomPolyfills();
afterEach(cleanup);

describe("AgentPanel mission list", () => {
  it("shows a failed mission list with a retry, not the « no mission » empty state", () => {
    const { store } = renderWithMission({ edits: [], ui: () => <AgentPanel contextToggle={null} /> });
    act(() =>
      store.setState((state) => ({
        workMode: "fix",
        missions: { ...state.missions, selectedId: null, list: [], listStatus: "error", listError: { code: "unavailable", providerError: null } },
      })),
    );
    expect(screen.getByText("Les missions n'ont pas pu être chargées")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(screen.queryByText("Aucune mission pour ce projet.")).toBeNull();
  });
});

describe("MissionCard", () => {
  it("says a mission without tasks recorded no steps, never « Aucune mission »", () => {
    renderWithMission({ edits: [], ui: (missionId) => <MissionCard missionId={missionId} /> });
    expect(screen.getByText("Pas d'étapes enregistrées")).toBeTruthy();
    expect(screen.queryByText("Aucune mission")).toBeNull();
  });

  it("« Voir le journal » shows the agent panel, even when it was hidden", () => {
    const { store, view } = renderWithMission({ edits: [], ui: (missionId) => <MissionCard missionId={missionId} /> });
    act(() =>
      store.setState((state) => ({
        missions: { ...state.missions, views: { [view.mission.id]: { ...view, mission: { ...view.mission, state: "running", endedAt: null } } } },
        ui: { ...state.ui, route: "chat", agentOpen: false, contextOverlayOpen: true },
      })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Voir le journal" }));
    expect(store.getState().missions.selectedId).toBe(view.mission.id);
    expect(store.getState().ui).toMatchObject({ route: "chat", agentOpen: true, contextOverlayOpen: false });
  });
});

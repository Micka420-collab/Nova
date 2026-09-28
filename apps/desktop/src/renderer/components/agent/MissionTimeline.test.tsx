// The budget stop banner: the new cap is proposed and explained in French notation.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MissionEvent } from "@nova/shared";
import { useApp } from "../../state/context";
import { installDomPolyfills } from "../../test/dom";
import { renderWithMission } from "../diff/test-helpers";
import { applyMissionEvents, type MissionView } from "../missions/timeline";
import { MissionTimeline } from "./MissionTimeline";

installDomPolyfills();
afterEach(cleanup);

function suspendedAtCap(view: MissionView, cap: number): MissionView {
  const base = { missionId: view.mission.id, at: 2_000 };
  const budget = { budgetUsd: cap, reservedUsd: 0, spentUsd: cap * 0.8, unknownCostCalls: 0, dailySpentUsd: 0, dailyLimitUsd: 5 };
  const events: MissionEvent[] = [
    { ...base, id: "e1", seq: 100, type: "budget.updated", budget },
    { ...base, id: "e2", seq: 101, type: "mission.suspended", reason: "budget", detail: null },
  ];
  return applyMissionEvents({ ...view, mission: { ...view.mission, state: "running" } }, events);
}

function Suspended({ missionId, cap }: { missionId: string; cap: number }) {
  const view = useApp((state) => state.missions.views[missionId]);
  return view ? <MissionTimeline view={suspendedAtCap(view, cap)} /> : null;
}

describe("MissionTimeline budget stop", () => {
  it("proposes twice the cap, with a decimal comma", () => {
    renderWithMission({ edits: [], ui: (missionId) => <Suspended missionId={missionId} cap={0.002} /> });
    expect(screen.getByRole("textbox", { name: "Nouveau plafond de la mission ($)" })).toHaveProperty("value", "0,004");
  });

  it("explains an invalid new cap with the current cap written the French way", () => {
    renderWithMission({ edits: [], ui: (missionId) => <Suspended missionId={missionId} cap={0.5} /> });
    fireEvent.change(screen.getByRole("textbox", { name: "Nouveau plafond de la mission ($)" }), { target: { value: "0,1" } });
    expect(screen.getByText(/Le nouveau plafond doit dépasser 0,50 \$/)).toBeTruthy();
    expect(screen.queryByText(/0\.50/)).toBeNull();
  });
});

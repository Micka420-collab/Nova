// End card counts and totals: every change is counted, and unknown usage is never shown as exact.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MissionEvent } from "@nova/shared";
import { useApp } from "../../state/context";
import { installDomPolyfills } from "../../test/dom";
import { renderWithMission } from "../diff/test-helpers";
import { applyMissionEvents, type MissionView } from "../missions/timeline";
import { EndCard } from "./EndCard";

installDomPolyfills();
afterEach(cleanup);

const usage = { promptTokens: 1_200, completionTokens: 80, reasoningTokens: null, cachedTokens: null, cost: 0.001 };

function ended(view: MissionView, extra: (base: () => { id: string; missionId: string; seq: number; at: number }) => MissionEvent[]): MissionView {
  let seq = 1_000;
  const base = () => ({ id: `e${++seq}`, missionId: view.mission.id, seq, at: 1_950 });
  return applyMissionEvents(view, [...extra(base), { ...base(), type: "mission.succeeded", summary: "Fait." }]);
}

function Ended({ missionId, extra }: { missionId: string; extra: Parameters<typeof ended>[1] }) {
  const view = useApp((state) => state.missions.views[missionId]);
  return view ? <EndCard view={ended(view, extra)} /> : null;
}

describe("EndCard", () => {
  it("counts a moved file, like the review button it shows", () => {
    renderWithMission({
      edits: [{ path: "src/b.ts", change: "moved", additions: 0, deletions: 0 }],
      ui: (missionId) => <Ended missionId={missionId} extra={() => []} />,
    });
    expect(screen.getByText(/0 fichier créé, 0 modifié, 0 supprimé, 1 déplacé/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Relire les changements" })).toBeTruthy();
  });

  it("shows token and web totals as lower bounds, or unknown, when some usage was not reported", () => {
    renderWithMission({
      edits: [],
      ui: (missionId) => (
        <Ended
          missionId={missionId}
          extra={(base) => [
            { ...base(), type: "message.completed", messageId: "m1", content: "a", usage },
            { ...base(), type: "message.completed", messageId: "m2", content: "b", usage: null },
            { ...base(), type: "tool.requested", taskId: null, call: { id: "w1", name: "web_search", operation: "network", argumentsPreview: "{}", path: null, host: null, argv: null } },
            { ...base(), type: "tool.finished", callId: "w1", state: "succeeded", durationMs: 5, display: { kind: "web_search", query: "q", citations: [], costUsd: null } },
          ]}
        />
      ),
    });
    expect(screen.getByText(/^au moins 1\s200 jetons envoyés · 80 reçus$/)).toBeTruthy();
    expect(screen.getByText("recherche Web : coût inconnu")).toBeTruthy();
  });
});

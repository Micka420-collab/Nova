import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissionContractInput, MissionPlanResult, MissionTaskDraft } from "@nova/shared";
import { makeContract } from "../../test/atelier-fake";
import { installDomPolyfills } from "../../test/dom";
import { ContractSheet } from "./ContractSheet";

installDomPolyfills();
afterEach(cleanup);

const WORKSPACE = "00000000-0000-4000-8000-00000000b001";
const MISSION = "00000000-0000-4000-8000-00000000a001";

function plan(): MissionPlanResult {
  return {
    mission: {
      id: MISSION,
      workspaceId: WORKSPACE,
      conversationId: null,
      title: "Corriger le panier",
      goal: "Le total est faux",
      mode: "fix",
      state: "ready",
      modelId: "vendor/model",
      createdAt: 1,
      startedAt: null,
      endedAt: null,
      updatedAt: 1,
    },
    contract: makeContract(WORKSPACE, { budgetUsd: 0.4 }),
    tasks: [
      { id: "t1", missionId: MISSION, seq: 1, title: "Reproduire", state: "todo", acceptance: { kind: "test_passes", detail: "pnpm test" } },
      { id: "t2", missionId: MISSION, seq: 2, title: "Corriger", state: "todo", acceptance: { kind: "manual", detail: "" } },
    ],
    summary: "Deux étapes.",
    estimate: { minUsd: 0.02, maxUsd: 0.1, assumptions: "4 à 10 appels" },
  };
}

function renderSheet(webSearch: boolean | null = null) {
  const onLaunch = vi.fn<(tasks: MissionTaskDraft[] | null, contract: MissionContractInput) => void>();
  render(
    <ContractSheet
      result={plan()}
      workspacePath="~/dev/mon-site"
      expert={false}
      starting={false}
      error={null}
      blocked={null}
      webSearch={webSearch}
      onLaunch={onLaunch}
      onCancel={() => undefined}
    />,
  );
  return onLaunch;
}

describe("ContractSheet", () => {
  it("never launches on a plain Entrée in a field; Ctrl+Entrée launches the edited plan", () => {
    const onLaunch = renderSheet();
    const title = screen.getByRole("textbox", { name: "Titre de l'étape 2" });
    fireEvent.change(title, { target: { value: "Corriger la remise" } });
    // Implicit submission of the form must not spend money.
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.submit(title.closest("form") as HTMLFormElement);
    expect(onLaunch).not.toHaveBeenCalled();

    fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const [tasks, contract] = onLaunch.mock.calls[0] ?? [];
    expect(tasks?.map((task) => task.title)).toEqual(["Reproduire", "Corriger la remise"]);
    expect(contract?.budgetUsd).toBe(0.4);
  });

  it("refuses an invalid budget with a message and launches nothing", () => {
    const onLaunch = renderSheet();
    fireEvent.change(screen.getByRole("textbox", { name: "Budget maximal ($)" }), { target: { value: "beaucoup" } });
    fireEvent.click(screen.getByRole("button", { name: "Lancer la mission" }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByText("Le budget doit être un montant supérieur à 0 $ et d'au plus 1 000 $.")).toBeTruthy();
  });

  it("starts from the Web toggle of the goal composer and says it in the contract", () => {
    const onLaunch = renderSheet(true);
    expect(screen.getByText("Recherche Web permise pour cette mission")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lancer la mission" }));
    expect(onLaunch.mock.calls[0]?.[1].webSearch).toBe(true);
  });
});

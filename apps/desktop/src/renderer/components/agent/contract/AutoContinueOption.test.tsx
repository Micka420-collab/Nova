import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AutoContinueOptions } from "@nova/shared";
import { installDomPolyfills } from "../../../test/dom";
import { AutoContinueOption, autoContinueAvailable, defaultAutoContinue, planHasProvableCriteria, validateAutoContinue, type AutoContinueChange } from "./AutoContinueOption";

installDomPolyfills();
afterEach(cleanup);

function setup(props: { value?: AutoContinueOptions | null; missionBudgetUsd?: number | null; hasCheckableCriteria?: boolean } = {}) {
  const changes: AutoContinueChange[] = [];
  const view = (missionBudgetUsd: number | null) => (
    <AutoContinueOption
      available
      value={props.value ?? null}
      missionBudgetUsd={missionBudgetUsd}
      hasCheckableCriteria={props.hasCheckableCriteria ?? true}
      onChange={(change) => changes.push(change)}
    />
  );
  const utils = render(view(props.missionBudgetUsd === undefined ? 0.5 : props.missionBudgetUsd));
  return { changes, rerender: (budget: number | null) => utils.rerender(view(budget)) };
}

describe("AutoContinueOption", () => {
  it("is off by default, explains itself, and turns on with bounded defaults", () => {
    const { changes } = setup();
    const toggle = screen.getByRole("switch", { name: "Jusqu’à preuve" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/NOVA relance l’agent pour un nouveau tour/)).toBeTruthy();
    expect(changes).toEqual([]);
    fireEvent.click(toggle);
    expect(changes.at(-1)).toEqual({ value: { maxRounds: 3, budgetUsd: 0.25 }, error: null });
    expect(screen.getByText(/Compris dans le budget de la mission/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(changes.at(-1)).toEqual({ value: null, error: null });
  });

  it("refuses rounds outside 1–10 and a cap above the mission budget, and re-checks when the budget drops", () => {
    const { changes, rerender } = setup({ value: { maxRounds: 2, budgetUsd: 0.2 } });
    fireEvent.change(screen.getByLabelText(/Tours au maximum/), { target: { value: "11" } });
    expect(changes.at(-1)).toEqual({ value: null, error: "Un nombre entier de 1 à 10." });
    fireEvent.change(screen.getByLabelText(/Tours au maximum/), { target: { value: "4" } });
    expect(changes.at(-1)).toEqual({ value: { maxRounds: 4, budgetUsd: 0.2 }, error: null });
    fireEvent.change(screen.getByLabelText(/Plafond pour la poursuite/), { target: { value: "0,8" } });
    expect(changes.at(-1)?.error).toBe("Le plafond ne peut pas dépasser le budget de la mission.");
    fireEvent.change(screen.getByLabelText(/Plafond pour la poursuite/), { target: { value: "0,3" } });
    expect(changes.at(-1)).toEqual({ value: { maxRounds: 4, budgetUsd: 0.3 }, error: null });
    rerender(0.1);
    expect(changes.at(-1)?.error).toBe("Le plafond ne peut pas dépasser le budget de la mission.");
  });

  it("warns when the plan has only criteria to confirm by the user", () => {
    setup({ value: { maxRounds: 2, budgetUsd: 0.1 }, hasCheckableCriteria: false });
    expect(screen.getByText(/cette option ne lancera aucun tour/)).toBeTruthy();
  });

  it("renders nothing when the mode runs no tool", () => {
    const { container } = render(<AutoContinueOption available={false} value={null} missionBudgetUsd={1} hasCheckableCriteria onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("validates as a pure function too", () => {
    expect(defaultAutoContinue(0.35)).toEqual({ maxRounds: 3, budgetUsd: 0.17 });
    expect(defaultAutoContinue(null)).toEqual({ maxRounds: 3, budgetUsd: 0 });
    expect(validateAutoContinue("2,5", "0,1", 1).error).toBe("Un nombre entier de 1 à 10.");
    expect(validateAutoContinue("2", "abc", 1).error).toBe("Un montant positif, par exemple 0,20.");
    expect(validateAutoContinue("2", "0", null)).toEqual({ value: { maxRounds: 2, budgetUsd: 0 }, error: null });
  });

  it("knows when the plan has something NOVA can prove in this mode", () => {
    const step = (kind: "test_passes" | "command_succeeds" | "file_exists" | "manual", detail = "npm test") => ({ acceptance: { kind, detail } });
    expect(planHasProvableCriteria("fix", [step("manual"), step("test_passes")])).toBe(true);
    expect(planHasProvableCriteria("fix", [step("manual"), step("command_succeeds", "  ")])).toBe(false);
    expect(planHasProvableCriteria("understand", [step("test_passes")])).toBe(false);
    expect(planHasProvableCriteria("understand", [step("file_exists", "README.md")])).toBe(true);
    expect(planHasProvableCriteria("verify", [step("command_succeeds", "npm run build")])).toBe(true);
    expect(autoContinueAvailable("discuss")).toBe(false);
    expect(autoContinueAvailable("plan")).toBe(true);
  });
});

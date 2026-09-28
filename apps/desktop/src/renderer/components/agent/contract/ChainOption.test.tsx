import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installDomPolyfills } from "../../../test/dom";
import { ChainOption } from "./ChainOption";

installDomPolyfills();
afterEach(cleanup);

describe("ChainOption", () => {
  it("explains the mode and its limits, and reports the choice", () => {
    const changes: boolean[] = [];
    render(<ChainOption available checked={false} onCheckedChange={(checked) => changes.push(checked)} />);
    const toggle = screen.getByRole("switch", { name: "Mode « Chaîne »" });
    expect(screen.getByText(/reste soumis à tes règles et à tes approbations/)).toBeTruthy();
    expect(screen.getByText(/Limites : 50 appels d’outil et 5 min par programme/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(changes).toEqual([true]);
  });

  it("renders nothing when the mode cannot offer it", () => {
    const { container } = render(<ChainOption available={false} checked={false} onCheckedChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

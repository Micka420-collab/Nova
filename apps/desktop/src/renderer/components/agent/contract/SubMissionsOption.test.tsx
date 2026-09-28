import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installDomPolyfills } from "../../../test/dom";
import { SubMissionsOption, type SubMissionsValue } from "./SubMissionsOption";

installDomPolyfills();
afterEach(cleanup);

describe("SubMissionsOption", () => {
  it("explains delegation, turns it on with a bounded count, and reports the choice", () => {
    const changes: SubMissionsValue[] = [];
    const { rerender } = render(<SubMissionsOption available value={null} onChange={(value) => changes.push(value)} />);
    expect(screen.getByText(/contrat jamais plus large que celui-ci/)).toBeTruthy();
    expect(screen.getByText(/2 au plus en même temps/)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Sous-missions" }));
    expect(changes).toEqual([{ maxChildren: 2 }]);

    rerender(<SubMissionsOption available value={{ maxChildren: 2 }} onChange={(value) => changes.push(value)} />);
    const group = screen.getByRole("radiogroup", { name: "Nombre maximum de sous-missions" });
    expect(group.querySelectorAll("[role=radio]")).toHaveLength(4);
    fireEvent.click(screen.getByRole("radio", { name: "4" }));
    fireEvent.click(screen.getByRole("switch", { name: "Sous-missions" }));
    expect(changes).toEqual([{ maxChildren: 2 }, { maxChildren: 4 }, null]);
  });

  it("renders nothing when the mode cannot offer it", () => {
    const { container } = render(<SubMissionsOption available={false} value={null} onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Nomi } from "./Nomi";
import { NOMI_STATES, NOMI_STATE_LABELS } from "./states";

afterEach(cleanup);

describe("Nomi", () => {
  it.each(NOMI_STATES)("renders %s as a named image with its French label", (state) => {
    render(<Nomi state={state} />);
    const image = screen.getByRole("img", { name: NOMI_STATE_LABELS[state] });
    expect(image.getAttribute("data-state")).toBe(state);
    expect(image.classList.contains("nv-nomi--reduced-motion")).toBe(false);
  });

  it("uses the French microcopy", () => {
    expect(NOMI_STATE_LABELS).toMatchObject({
      offline: "Nomi est hors ligne",
      idle: "Nomi est disponible",
      thinking: "Nomi réfléchit",
      waiting: "Nomi attend ta réponse",
      success: "Terminé",
      error: "Quelque chose a échoué",
    });
  });

  it.each(NOMI_STATES)("freezes %s with the reduced motion class", (state) => {
    render(<Nomi state={state} motion="reduced" />);
    const image = screen.getByRole("img", { name: NOMI_STATE_LABELS[state] });
    expect(image.classList.contains("nv-nomi--reduced-motion")).toBe(true);
  });

  it("keeps static poses distinct: closed eyes offline, happy eyes on success, a mouth only when speaking", () => {
    const eyes = (state: (typeof NOMI_STATES)[number]) => {
      const { container, unmount } = render(<Nomi state={state} motion="reduced" />);
      const shape = {
        lids: container.querySelectorAll(".nv-nomi__lid").length,
        pupils: container.querySelectorAll(".nv-nomi__pupil").length,
        mouth: container.querySelectorAll(".nv-nomi__mouth").length,
        lid: container.querySelector(".nv-nomi__lid")?.getAttribute("d") ?? null,
      };
      unmount();
      return shape;
    };
    expect(eyes("idle")).toEqual({ lids: 0, pupils: 2, mouth: 0, lid: null });
    expect(eyes("speaking")).toMatchObject({ pupils: 2, mouth: 1 });
    const offline = eyes("offline");
    const success = eyes("success");
    expect(offline).toMatchObject({ lids: 2, pupils: 0 });
    expect(success).toMatchObject({ lids: 2, pupils: 0 });
    expect(offline.lid).not.toBe(success.lid);
  });

  it("accepts a custom label and size", () => {
    render(<Nomi state="working" size={32} label="Nomi prépare le plan" />);
    const image = screen.getByRole("img", { name: "Nomi prépare le plan" });
    expect(image.getAttribute("width")).toBe("32");
  });
});

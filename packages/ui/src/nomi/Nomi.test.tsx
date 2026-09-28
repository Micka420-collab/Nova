import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Nomi } from "./Nomi";
import {
  NOMI_ACTIVITIES,
  NOMI_STATES,
  NOMI_STATE_LABELS,
  nomiAccessory,
  type NomiActivity,
  type NomiState,
} from "./states";

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

describe("Nomi activities and accessories", () => {
  const accessoryOf = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-accessory]")].map((node) => node.getAttribute("data-accessory"));

  it.each<[NomiState, NomiActivity, string | null, string]>([
    ["thinking", "reading", "glasses", "Nomi lit un fichier"],
    ["thinking", "searching", "glasses", "Nomi cherche"],
    ["thinking", "debugging", "probe", "Nomi cherche la cause d'une erreur"],
    ["working", "editing", "tool", "Nomi modifie un fichier"],
    ["working", "running", "card", "Nomi lance une commande"],
    ["working", "testing", "card", "Nomi lance les tests"],
    ["working", "none", null, "Nomi travaille"],
    // An activity that does not match the pose holds nothing (no accessory without its state).
    ["idle", "editing", null, "Nomi est disponible"],
    ["success", "testing", null, "Terminé"],
    ["thinking", "editing", null, "Nomi réfléchit"],
  ])("%s + %s → %s, named « %s », at 32 and 96 px", (state, activity, accessory, name) => {
    for (const size of [32, 96]) {
      const { container, unmount } = render(<Nomi state={state} activity={activity} size={size} />);
      const image = screen.getByRole("img", { name });
      expect(image.getAttribute("width")).toBe(String(size));
      expect(accessoryOf(container)).toEqual(accessory ? [accessory] : []);
      unmount();
    }
  });

  it("agrees with nomiAccessory for every state × activity pair", () => {
    for (const state of NOMI_STATES) {
      for (const activity of NOMI_ACTIVITIES) {
        const { container, unmount } = render(<Nomi state={state} activity={activity} motion="reduced" />);
        const expected = nomiAccessory(state, activity);
        expect(accessoryOf(container)).toEqual(expected ? [expected] : []);
        unmount();
      }
    }
  });

  it("keeps accessories as static poses under reduced motion", () => {
    const { container } = render(<Nomi state="working" activity="editing" motion="reduced" size={32} />);
    const image = screen.getByRole("img", { name: "Nomi modifie un fichier" });
    expect(image.classList.contains("nv-nomi--reduced-motion")).toBe(true);
    expect(accessoryOf(container)).toEqual(["tool"]);
  });

  it("shows the pocket while a file is dragged over, whatever the state", () => {
    const { container } = render(<Nomi state="idle" dragOver />);
    expect(accessoryOf(container)).toEqual(["pocket"]);
    expect(container.querySelector("svg")?.hasAttribute("data-drag-over")).toBe(true);
  });

  it("marks the waiting flavor, quiet mode and a static (non-lead) instance", () => {
    const { container, rerender } = render(<Nomi state="waiting" waiting="suspended" />);
    const svg = () => container.querySelector("svg");
    expect(svg()?.getAttribute("data-waiting")).toBe("suspended");
    rerender(<Nomi state="idle" waiting="suspended" quiet presence="static" />);
    expect(svg()?.hasAttribute("data-waiting")).toBe(false);
    expect(svg()?.hasAttribute("data-quiet")).toBe(true);
    expect(svg()?.classList.contains("nv-nomi--static")).toBe(true);
  });

  it("pauses its animations while the window is hidden, and resumes when visible", () => {
    let visibility: DocumentVisibilityState = "visible";
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const { container } = render(<Nomi state="working" />);
      const svg = () => container.querySelector("svg");
      expect(svg()?.classList.contains("nv-nomi--paused")).toBe(false);
      act(() => {
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(svg()?.classList.contains("nv-nomi--paused")).toBe(true);
      act(() => {
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(svg()?.classList.contains("nv-nomi--paused")).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });
});

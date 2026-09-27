import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

afterEach(cleanup);

type View = "conversation" | "mission" | "fichiers" | "reglages";

function Harness({ initial = "conversation" }: { initial?: View }) {
  const [view, setView] = useState<View>(initial);
  return (
    <SegmentedControl
      label="Vue"
      value={view}
      onChange={setView}
      options={[
        { value: "conversation", label: "Conversation" },
        { value: "mission", label: "Mission" },
        { value: "fichiers", label: "Fichiers", disabled: true },
        { value: "reglages", label: "Réglages" },
      ]}
    />
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });
const checked = () => screen.getAllByRole("radio").filter((el) => el.getAttribute("aria-checked") === "true");

describe("SegmentedControl", () => {
  it("exposes a labelled radio group with a single tab stop on the selection", () => {
    render(<Harness initial="mission" />);
    expect(screen.getByRole("radiogroup", { name: "Vue" })).toBeTruthy();
    expect(checked()).toEqual([radio("Mission")]);
    expect(screen.getAllByRole("radio").map((el) => el.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it("moves selection and focus with the arrow keys, skipping disabled options and wrapping", () => {
    render(<Harness />);
    radio("Conversation").focus();

    fireEvent.keyDown(radio("Conversation"), { key: "ArrowRight" });
    expect(checked()).toEqual([radio("Mission")]);
    expect(document.activeElement).toBe(radio("Mission"));

    fireEvent.keyDown(radio("Mission"), { key: "ArrowDown" });
    expect(checked()).toEqual([radio("Réglages")]);

    fireEvent.keyDown(radio("Réglages"), { key: "ArrowRight" });
    expect(checked()).toEqual([radio("Conversation")]);

    fireEvent.keyDown(radio("Conversation"), { key: "ArrowLeft" });
    expect(checked()).toEqual([radio("Réglages")]);
    expect(document.activeElement).toBe(radio("Réglages"));
    expect(radio("Réglages").tabIndex).toBe(0);
  });

  it("jumps with Home and End and ignores other keys", () => {
    render(<Harness initial="mission" />);
    fireEvent.keyDown(radio("Mission"), { key: "End" });
    expect(checked()).toEqual([radio("Réglages")]);
    fireEvent.keyDown(radio("Réglages"), { key: "Home" });
    expect(checked()).toEqual([radio("Conversation")]);
    fireEvent.keyDown(radio("Conversation"), { key: "a" });
    expect(checked()).toEqual([radio("Conversation")]);
  });

  it("selects on click", () => {
    render(<Harness />);
    fireEvent.click(radio("Réglages"));
    expect(checked()).toEqual([radio("Réglages")]);
  });
});

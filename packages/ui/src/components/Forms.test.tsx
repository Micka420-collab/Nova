import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Switch } from "./Switch";
import { TextArea, TextField } from "./TextField";

afterEach(cleanup);

const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent);

describe("TextField and TextArea", () => {
  it("labels the control and describes it with the hint", () => {
    render(<TextField label="Nom de la mission" hint="Visible sur cet appareil." />);
    const input = screen.getByRole("textbox", { name: "Nom de la mission" });
    expect(describedBy(input)).toEqual(["Visible sur cet appareil."]);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("marks an error as invalid and keeps caller descriptions", () => {
    render(
      <>
        <p id="external">Aide externe</p>
        <TextField label="Clé API" aria-describedby="external" hint="Commence par sk-" error="Clé refusée." />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Clé API" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(input)).toEqual(["Aide externe", "Commence par sk-", "Clé refusée."]);
  });

  it("keeps the accessible name when the label is visually hidden", () => {
    render(<TextArea label="Consigne" hideLabel error="Consigne vide." />);
    const textarea = screen.getByRole("textbox", { name: "Consigne" });
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Switch", () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return <Switch label="Afficher Nomi" description="Reflète l’état réel." checked={on} onCheckedChange={setOn} />;
  }

  it("is a labelled switch toggled by the control and by its label", () => {
    render(<Harness />);
    const control = screen.getByRole("switch", { name: "Afficher Nomi" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(describedBy(control)).toEqual(["Reflète l’état réel."]);
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText("Afficher Nomi"));
    expect(control.getAttribute("aria-checked")).toBe("false");
  });
});

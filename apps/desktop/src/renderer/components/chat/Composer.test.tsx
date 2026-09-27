import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./Composer";

afterEach(cleanup);

function setup(props: Partial<ComposerProps> = {}) {
  const onSend = vi.fn<ComposerProps["onSend"]>(async () => true);
  const onStop = vi.fn<() => void>();
  render(<Composer label="Message" streaming={false} blocked={null} onSend={onSend} onStop={onStop} {...props} />);
  const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(input, { target: { value: text } });
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () => {
      fireEvent.keyDown(input, { key, ...init });
    });
  };
  return { input, onSend, onStop, type, press };
}

describe("Composer", () => {
  it("Enter sends the trimmed text and clears the field once it left", async () => {
    const { input, onSend, type, press } = setup();
    type("  Bonjour Nomi  ");
    await press("Enter");
    expect(onSend).toHaveBeenCalledWith("Bonjour Nomi");
    expect(input.value).toBe("");
  });

  it("Shift+Enter does not send (new line), nor Enter while composing with an IME", async () => {
    const { onSend, type, press } = setup();
    type("Ligne 1");
    await press("Enter", { shiftKey: true });
    await press("Enter", { isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the text when the message could not be sent", async () => {
    const { input, type, press } = setup({ onSend: async () => false });
    type("Important");
    await press("Enter");
    expect(input.value).toBe("Important");
  });

  it("does not send empty text", async () => {
    const { onSend, type, press } = setup();
    type("   ");
    await press("Enter");
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("while streaming, shows Stop instead of Send; Escape and the button stop, Enter does not send", async () => {
    const { onSend, onStop, type, press } = setup({ streaming: true });
    expect(screen.queryByRole("button", { name: "Envoyer" })).toBeNull();
    type("Suite");
    await press("Enter");
    expect(onSend).not.toHaveBeenCalled();
    await press("Escape");
    fireEvent.click(screen.getByRole("button", { name: "Arrêter" }));
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("when blocked, shows the reason with its action and never sends", async () => {
    const onAction = vi.fn<() => void>();
    const { input, onSend, type, press } = setup({
      blocked: { reason: "Choisis un modèle pour envoyer ton message.", action: { label: "Choisir", onAction } },
    });
    type("Bonjour");
    await press("Enter");
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Choisis un modèle pour envoyer ton message.")).toBeTruthy();
    // The reason is announced with the field.
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByText("Choisis un modèle pour envoyer ton message.").parentElement?.id);
    fireEvent.click(screen.getByRole("button", { name: "Choisir" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});

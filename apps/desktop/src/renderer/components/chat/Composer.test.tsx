import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutopilotChoice } from "@nova/shared";
import { makeModel } from "../../test/fake-bridge";
import type { AutopilotPhase } from "./autopilot/autopilot-state";
import type { AutopilotControl } from "./autopilot/useAutopilot";
import { Composer, type ComposerProps } from "./Composer";
import type { ImageAttachments } from "./vision/useImageAttachments";

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

describe("Composer J2-B L7 helpers", () => {
  const png = { mediaType: "image/png" as const, dataBase64: "iVBORw0KGgo=", name: "capture.png" };

  function imagesControl(partial: Partial<ImageAttachments> = {}): ImageAttachments {
    return {
      items: [],
      images: [],
      notice: null,
      add: vi.fn<ImageAttachments["add"]>(async () => undefined),
      remove: vi.fn<ImageAttachments["remove"]>(),
      clear: vi.fn<ImageAttachments["clear"]>(),
      block: null,
      suggestion: null,
      ...partial,
    };
  }

  function autopilotControl(phase: AutopilotPhase): AutopilotControl {
    return {
      phase,
      classify: vi.fn<AutopilotControl["classify"]>(async () => undefined),
      dispatch: vi.fn<AutopilotControl["dispatch"]>(),
      reset: vi.fn<AutopilotControl["reset"]>(),
    };
  }

  const choice: AutopilotChoice = {
    reasoningEffort: "high",
    webSearch: false,
    rationale: "Demande complexe : effort élevé, sans recherche web.",
    classifierModelId: "vendor/cheap",
    costUsd: 0.00001,
    source: "classifier",
  };

  it("a pasted image joins the message and leaves with it, then the strip is cleared", async () => {
    const images = imagesControl({ items: [{ id: 1, image: png }], images: [png] });
    const { input, onSend, type, press } = setup({ images });
    const file = new File(["p"], "p.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { files: [file] } });
    expect(images.add).toHaveBeenCalledWith([file]);
    expect(screen.getByRole("img", { name: "capture.png" })).toBeTruthy();
    expect(screen.getByText(/NOVA ne les enregistre pas/)).toBeTruthy();
    type("Que montre l'image ?");
    await press("Enter");
    expect(onSend).toHaveBeenCalledWith("Que montre l'image ?", { images: [png] });
    expect(images.clear).toHaveBeenCalledOnce();
  });

  it("does not send images to a model that cannot read them: reason, fix and suggestion are shown", async () => {
    const choose = vi.fn<() => Promise<void>>(async () => undefined);
    const images = imagesControl({
      items: [{ id: 1, image: png }],
      images: [png],
      block: { reason: "Texte seul ne lit pas les images." },
      suggestion: { model: makeModel({ id: "acme/vision", name: "Acme Vision", inputModalities: ["text", "image"] }), choose },
    });
    const { onSend, type, press } = setup({ images });
    type("Décris");
    await press("Enter");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("Texte seul ne lit pas les images.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Utiliser Acme Vision" }));
    expect(choose).toHaveBeenCalledOnce();
  });

  it("with the autopilot, the first Enter shows the choice and the second sends it (as overridden)", async () => {
    const idle = autopilotControl({ kind: "idle" });
    const first = setup({ autopilot: idle });
    expect(screen.getByText(/Pilote automatique : Entrée prépare les réglages/)).toBeTruthy();
    first.type("Compare ces deux architectures");
    await first.press("Enter");
    expect(idle.classify).toHaveBeenCalledWith("Compare ces deux architectures", false);
    expect(first.onSend).not.toHaveBeenCalled();
    cleanup();

    const ready = autopilotControl({ kind: "ready", choice, reasoningEffort: "medium", webSearch: true });
    const second = setup({ autopilot: ready });
    expect(screen.getByText(choice.rationale)).toBeTruthy();
    expect(screen.getByText(/Estimé par vendor\/cheap/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Élevé" }));
    expect(ready.dispatch).toHaveBeenCalledWith({ type: "effort", value: "high" });
    second.type("Compare ces deux architectures");
    await second.press("Enter");
    expect(second.onSend).toHaveBeenCalledWith("Compare ces deux architectures", { reasoningEffort: "medium", webSearch: true });
    expect(ready.reset).toHaveBeenCalledOnce();
  });

  it("says when the choice is NOVA's fallback, and never sends while the estimate runs", async () => {
    const fallback = autopilotControl({ kind: "ready", choice: { ...choice, source: "fallback", classifierModelId: null, costUsd: 0 }, reasoningEffort: "medium", webSearch: false });
    setup({ autopilot: fallback });
    expect(screen.getByRole("region", { name: "Réglages par défaut" })).toBeTruthy();
    cleanup();

    const busy = autopilotControl({ kind: "classifying" });
    const { onSend, type, press } = setup({ autopilot: busy });
    expect(screen.getByText("Analyse du message…")).toBeTruthy();
    type("Encore");
    await press("Enter");
    expect(onSend).not.toHaveBeenCalled();
    expect(busy.classify).not.toHaveBeenCalled();
  });

  it("when main does not serve the autopilot, says so and the next Enter sends without it", async () => {
    const failed = autopilotControl({ kind: "failed", unavailable: true });
    const { onSend, type, press } = setup({ autopilot: failed });
    expect(screen.getByRole("alert").textContent).toContain("n'est pas disponible");
    type("Bonjour");
    await press("Enter");
    expect(onSend).toHaveBeenCalledWith("Bonjour");
  });

  it("after a classifier failure, « Envoyer sans pilote » sends plainly and Enter retries the estimate", async () => {
    const failed = autopilotControl({ kind: "failed", unavailable: false });
    const { onSend, type, press } = setup({ autopilot: failed });
    type("Bonjour");
    await press("Enter");
    expect(failed.classify).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Envoyer sans pilote" }));
    });
    expect(onSend).toHaveBeenCalledWith("Bonjour");
  });
});

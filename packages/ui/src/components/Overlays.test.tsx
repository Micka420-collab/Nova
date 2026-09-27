import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, useToast, type ToastOptions } from "./Toast";
import { Tooltip } from "./Tooltip";

afterEach(cleanup);

describe("Toaster", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function Trigger({ toast }: { toast: ToastOptions }) {
    const { show } = useToast();
    return (
      <button type="button" onClick={() => show(toast)}>
        Notifier
      </button>
    );
  }

  const live = () => screen.getByRole("region", { name: "Notifications" }).querySelector('[aria-live="polite"]');

  it("announces toasts in a polite live region that exists before any toast", () => {
    render(
      <Toaster>
        <Trigger toast={{ title: "Conversation exportée", tone: "success" }} />
      </Toaster>,
    );
    expect(live()?.childElementCount).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Notifier" }));
    expect(live()?.textContent).toContain("Conversation exportée");
  });

  it("auto-dismisses after its duration, pausing while hovered", () => {
    render(
      <Toaster>
        <Trigger toast={{ title: "Enregistré", durationMs: 1000 }} />
      </Toaster>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifier" }));
    const toast = screen.getByText("Enregistré").closest("li");
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerEnter(toast as HTMLElement);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Enregistré")).not.toBeNull();
    fireEvent.pointerLeave(toast as HTMLElement);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.queryByText("Enregistré")).not.toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText("Enregistré")).toBeNull();
  });

  it("keeps danger toasts until dismissed", () => {
    render(
      <Toaster>
        <Trigger toast={{ title: "Génération interrompue", tone: "danger" }} />
      </Toaster>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifier" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText("Génération interrompue")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fermer la notification" }));
    expect(screen.queryByText("Génération interrompue")).toBeNull();
  });

  it("refuses to be used outside a Toaster", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Trigger toast={{ title: "x" }} />)).toThrow(/inside <Toaster>/);
  });
});

describe("Tooltip", () => {
  it("describes its trigger, shows on focus and hides on Escape and blur", () => {
    render(
      <Tooltip content="Nouvelle conversation">
        <button type="button" aria-label="Nouveau">
          +
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Nouveau" });
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.hidden).toBe(true);

    fireEvent.focus(trigger);
    expect(tooltip.hidden).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tooltip.hidden).toBe(true);

    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    expect(tooltip.hidden).toBe(true);
  });
});

import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

// jsdom has no modal dialog support: emulate opening (with the native initial focus), closing, and the
// close event, which browsers queue as a task.
const proto = HTMLDialogElement.prototype;
const native = { showModal: proto.showModal, close: proto.close };
beforeAll(() => {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("button, input")?.focus();
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    setTimeout(() => this.dispatchEvent(new Event("close")));
  };
});
afterAll(() => Object.assign(proto, native));
afterEach(cleanup);

const flushTasks = () => act(() => new Promise((resolve) => setTimeout(resolve)));

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Renommer
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Renommer la conversation"
        description="Le nouveau nom apparaît dans la liste."
      >
        <input aria-label="Nom" />
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("is labelled by its title and described by its description", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Renommer" }));
    const dialog = screen.getByRole("dialog", { name: "Renommer la conversation" });
    expect(dialog.hasAttribute("open")).toBe(true);
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Le nouveau nom apparaît dans la liste.");
  });

  it("closes on Escape (cancel event) and gives focus back to the opener", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Renommer" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes from its labelled close button and renders no content while closed", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Renommer" }));
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Nom" })).toBeNull();
  });

  it("reports a native close that the parent did not request", async () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Renommer" }));
    (screen.getByRole("dialog") as HTMLDialogElement).close();
    await flushTasks();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open when mounted open under StrictMode (replayed effect)", async () => {
    const onClose = vi.fn<() => void>();
    render(
      <StrictMode>
        <Dialog open onClose={onClose} title="Réglages" />
      </StrictMode>,
    );
    await flushTasks();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Réglages" }).hasAttribute("open")).toBe(true);
  });
});

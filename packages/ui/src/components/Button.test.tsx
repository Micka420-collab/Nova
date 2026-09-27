import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "./Button";

afterEach(cleanup);

describe("Button", () => {
  it("is a non-submitting button by default", () => {
    render(<Button>Envoyer</Button>);
    expect(screen.getByRole("button", { name: "Envoyer" }).getAttribute("type")).toBe("button");
  });

  it("loading sets aria-busy, disables the button and shows the active orbit", () => {
    const onClick = vi.fn<() => void>();
    render(
      <Button variant="primary" loading onClick={onClick}>
        Générer
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Générer" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".nv-orbit--active")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is interactive again once loading ends", () => {
    const onClick = vi.fn<() => void>();
    const { rerender } = render(
      <Button loading onClick={onClick}>
        Générer
      </Button>,
    );
    rerender(<Button onClick={onClick}>Générer</Button>);
    const button = screen.getByRole("button", { name: "Générer" }) as HTMLButtonElement;
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector(".nv-orbit")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("IconButton exposes its required label as the accessible name", () => {
    render(<IconButton aria-label="Réglages" icon={<svg aria-hidden />} />);
    expect(screen.getByRole("button", { name: "Réglages" })).toBeTruthy();
  });
});

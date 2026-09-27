import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffFile, DiffHunk, type DiffLine } from "./DiffView";

afterEach(cleanup);

const LINES: DiffLine[] = [
  { kind: "context", oldNumber: 12, newNumber: 12, text: "const email = input.value.trim();" },
  { kind: "del", oldNumber: 13, newNumber: null, text: "if (!email) return;" },
  { kind: "add", oldNumber: null, newNumber: 13, text: "if (!email) {" },
];

const labels = { add: "ajouté", del: "supprimé" };
const more = (count: number) => `Afficher ${count} lignes de plus`;

describe("DiffHunk", () => {
  it("is a named region whose changed lines carry a text prefix", () => {
    render(
      <DiffHunk header="@@ -12,2 +12,2 @@" context="validate()" lines={LINES} decision="pending" regionLabel="bloc 1 sur 3, lignes 12 à 13" lineLabels={labels} showMoreLabel={more} />,
    );
    const region = screen.getByRole("region", { name: "bloc 1 sur 3, lignes 12 à 13" });
    expect(within(region).getByText("validate()")).toBeTruthy();
    expect(within(region).getByText("ajouté", { exact: false }).parentElement?.textContent).toBe("ajouté if (!email) {");
    expect(within(region).getByText("supprimé", { exact: false }).parentElement?.textContent).toBe("supprimé if (!email) return;");
  });

  it("folds once decided and shows its pill", () => {
    render(
      <DiffHunk header="@@" lines={LINES} decision="kept" decisionPill={<span>gardé</span>} regionLabel="bloc" lineLabels={labels} showMoreLabel={more} />,
    );
    expect(screen.getByText("gardé")).toBeTruthy();
    expect(screen.queryByText("if (!email) {")).toBeNull();
  });

  it("keeps a conflict visible (dimmed) with its callout", () => {
    const { container } = render(
      <DiffHunk header="@@" lines={LINES} decision="conflict" conflict={<p>changé depuis</p>} regionLabel="bloc" lineLabels={labels} showMoreLabel={more} />,
    );
    expect(screen.getByText("changé depuis")).toBeTruthy();
    expect(screen.getByText("if (!email) {", { exact: false })).toBeTruthy();
    expect(container.querySelector(".nv-diff-hunk--conflict")).toBeTruthy();
  });

  it("caps long hunks and reveals more on demand", () => {
    const long: DiffLine[] = Array.from({ length: 5 }, (_, i) => ({ kind: "add", oldNumber: null, newNumber: i + 1, text: `line ${i + 1}` }));
    render(<DiffHunk header="@@" lines={long} decision="pending" regionLabel="bloc" lineLabels={labels} showMoreLabel={more} maxLines={2} />);
    expect(screen.queryByText("line 3", { exact: false })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Afficher 3 lignes de plus" }));
    expect(screen.getByText("line 4", { exact: false })).toBeTruthy();
  });
});

describe("DiffFile", () => {
  it("shows the path, counts and slots, and toggles its hunks", () => {
    const onToggle = vi.fn<() => void>();
    const { rerender } = render(
      <DiffFile path="src/form.tsx" additions={31} deletions={4} expanded={false} onToggle={onToggle} toggleLabel="Déplier src/form.tsx" proof={<span>test passé</span>} pill={<span>2 sur 3 gardés</span>}>
        <p>hunks</p>
      </DiffFile>,
    );
    expect(screen.getByText("src/")).toBeTruthy();
    expect(screen.getByText("form.tsx")).toBeTruthy();
    expect(screen.getByText("+31")).toBeTruthy();
    expect(screen.getByText("2 sur 3 gardés")).toBeTruthy();
    expect(screen.queryByText("hunks")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Déplier src/form.tsx" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <DiffFile path="src/form.tsx" additions={31} deletions={4} expanded onToggle={onToggle} toggleLabel="Replier src/form.tsx">
        <p>hunks</p>
      </DiffFile>,
    );
    expect(screen.getByText("hunks")).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";
import { BudgetMeter, type BudgetMeterProps } from "./BudgetMeter";
import { CitationChip } from "./CitationChip";
import { StatusBarItem } from "./StatusBar";
import { Tabs, type TabItem } from "./Tabs";
import { ToolCallCard } from "./ToolCallCard";

afterEach(cleanup);

function renderApproval(props: Partial<ApprovalCardProps> = {}) {
  const handlers = {
    onApproveOnce: vi.fn<() => void>(),
    onApproveMission: vi.fn<() => void>(),
    onDeny: vi.fn<() => void>(),
  };
  const all: ApprovalCardProps = {
    title: "Nomi veut lancer pnpm test",
    facts: [{ label: "Portée", value: "mon-site" }],
    irreversible: false,
    rememberable: true,
    status: "pending",
    labels: { approveOnce: "Autoriser une fois", approveMission: "Pour cette mission", deny: "Refuser" },
    ...handlers,
    ...props,
  };
  const view = render(<ApprovalCard {...all} />);
  return { ...handlers, view, props: all };
}

describe("ApprovalCard", () => {
  it("approves once with Ctrl+Enter or Meta+Enter from inside the card", () => {
    const { onApproveOnce, onApproveMission } = renderApproval();
    const card = screen.getByRole("alertdialog");
    fireEvent.keyDown(card, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Refuser" }), { key: "Enter", metaKey: true });
    expect(onApproveOnce).toHaveBeenCalledTimes(2);
    expect(onApproveMission).not.toHaveBeenCalled();
  });

  it("approves for the mission with Ctrl+Shift+Enter only when rememberable and reversible", () => {
    const first = renderApproval();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(first.onApproveMission).toHaveBeenCalledTimes(1);
    expect(first.onApproveOnce).not.toHaveBeenCalled();
    cleanup();

    const irreversible = renderApproval({ irreversible: true });
    expect(screen.queryByRole("button", { name: "Pour cette mission" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(irreversible.onApproveMission).not.toHaveBeenCalled();
    expect(irreversible.onApproveOnce).not.toHaveBeenCalled();
    cleanup();

    const once = renderApproval({ rememberable: false });
    expect(screen.queryByRole("button", { name: "Pour cette mission" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter", metaKey: true, shiftKey: true });
    expect(once.onApproveMission).not.toHaveBeenCalled();
  });

  it("denies with Escape, and a plain Enter on the card does nothing", () => {
    const { onDeny, onApproveOnce } = renderApproval();
    const card = screen.getByRole("alertdialog");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onApproveOnce).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("ignores shortcuts while busy and once decided", () => {
    const busy = renderApproval({ busy: true });
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(busy.onApproveOnce).not.toHaveBeenCalled();
    expect(busy.onDeny).not.toHaveBeenCalled();
    cleanup();

    const decided = renderApproval({ status: "approved", decidedLabel: "Autorisé une fois · 14:04" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    const line = screen.getByText("Autorisé une fois · 14:04");
    fireEvent.keyDown(line, { key: "Enter", ctrlKey: true });
    expect(decided.onApproveOnce).not.toHaveBeenCalled();
  });

  it("moves focus to “approve once” only on a new focus request", () => {
    const outside = document.createElement("textarea");
    document.body.append(outside);
    const { view, props } = renderApproval({ focusRequest: null });
    outside.focus();
    expect(document.activeElement).toBe(outside);

    view.rerender(<ApprovalCard {...props} focusRequest={1} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Autoriser une fois" }));

    outside.focus();
    view.rerender(<ApprovalCard {...props} focusRequest={1} busy={false} />);
    expect(document.activeElement).toBe(outside);
    view.rerender(<ApprovalCard {...props} focusRequest={null} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

const LABELS: BudgetMeterProps["labels"] = {
  label: "Budget de la mission",
  spent: (amount) => `${amount} constaté`,
  reserved: (amount) => `${amount} réservé`,
  cap: (amount) => `plafond ${amount}`,
  noCap: "sans plafond",
  atLeast: "au moins",
  unknownCalls: (count) => `(${count} appels sans coût rapporté)`,
  suspended: "suspendue",
  valueText: (spent, cap, atLeast) => `${atLeast ? "au moins " : ""}${spent} constaté${cap ? ` sur ${cap}` : ", sans plafond"}`,
};
const format = (usd: number) => `${usd.toFixed(2)} $`;

describe("BudgetMeter", () => {
  it("says “au moins” when some costs were not reported", () => {
    render(<BudgetMeter spentUsd={0.42} reservedUsd={0.1} capUsd={2} unknownCostCalls={2} variant="card" format={format} labels={LABELS} />);
    const meter = screen.getByRole("meter", { name: "Budget de la mission" });
    expect(meter.getAttribute("aria-valuetext")).toBe("au moins 0.42 $ constaté sur 2.00 $");
    expect(meter.getAttribute("aria-valuemax")).toBe("2");
    expect(meter.textContent).toContain("(2 appels sans coût rapporté)");
    expect(meter.className).not.toMatch(/nv-budget--(warn|over)/);
  });

  it("warns from 80 % and marks 100 % as over, with the suspended pill", () => {
    const { rerender } = render(
      <BudgetMeter spentUsd={0.4} reservedUsd={0} capUsd={0.5} unknownCostCalls={0} variant="inline" format={format} labels={LABELS} />,
    );
    expect(screen.getByRole("meter").className).toContain("nv-budget--warn");
    rerender(
      <BudgetMeter spentUsd={0.5} reservedUsd={0} capUsd={0.5} unknownCostCalls={0} variant="card" suspended format={format} labels={LABELS} />,
    );
    const meter = screen.getByRole("meter");
    expect(meter.className).toContain("nv-budget--over");
    expect(meter.textContent).toContain("suspendue");
  });

  it("without a cap is never over and has no maximum", () => {
    render(<BudgetMeter spentUsd={50} reservedUsd={0} capUsd={null} unknownCostCalls={0} variant="inline" format={format} labels={LABELS} />);
    const meter = screen.getByRole("meter");
    expect(meter.className).not.toMatch(/nv-budget--(warn|over)/);
    expect(meter.getAttribute("aria-valuemax")).toBeNull();
    expect(meter.getAttribute("aria-valuetext")).toBe("50.00 $ constaté, sans plafond");
  });
});

describe("ToolCallCard", () => {
  function Card({ status, orbit }: { status: "running" | "succeeded"; orbit?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <ToolCallCard kind="read" title="Lire" status={status} statusLabel="en cours" orbit={orbit} expanded={expanded} onExpandedChange={setExpanded}>
        <p>corps</p>
      </ToolCallCard>
    );
  }

  it("toggles aria-expanded and shows its body only when expanded", () => {
    render(<Card status="succeeded" />);
    const toggle = screen.getByRole("button", { name: /Lire/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("corps")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("corps")).toBeTruthy();
  });

  it("spins the orbit only while running and when allowed", () => {
    const { container, rerender } = render(<Card status="running" />);
    expect(container.querySelector(".nv-orbit--active")).not.toBeNull();
    rerender(<Card status="running" orbit={false} />);
    expect(container.querySelector(".nv-orbit")).toBeNull();
    rerender(<Card status="succeeded" />);
    expect(container.querySelector(".nv-orbit")).toBeNull();
  });
});

describe("Tabs", () => {
  const items: TabItem[] = [
    { key: "context", label: "Contexte" },
    { key: "diff:1", label: "Changements", closable: true, closeLabel: "Fermer Changements" },
    { key: "mission:1", label: "Mission", closable: true, closeLabel: "Fermer Mission" },
  ];

  it("moves and selects with arrows, Home and End; Delete closes a closable tab", () => {
    const onSelect = vi.fn<(key: string) => void>();
    const onClose = vi.fn<(key: string) => void>();
    render(<Tabs label="Documents" idPrefix="wb" items={items} activeKey="context" onSelect={onSelect} onClose={onClose} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("diff:1");
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("mission:1");
    fireEvent.keyDown(tabs[1] as HTMLElement, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("context");
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("mission:1");
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "Delete" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(tabs[1] as HTMLElement, { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith("diff:1");
    expect(tabs[1]?.id).toBe("wb-tab-diff_1");
  });
});

describe("CitationChip", () => {
  it("is a named button; Ctrl/⌘+click opens in the background", () => {
    const onOpen = vi.fn<(options: { background: boolean }) => void>();
    render(<CitationChip kind="file" label="form.tsx:13" accessibleName="Ouvrir form.tsx ligne 13" onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: "Ouvrir form.tsx ligne 13" });
    fireEvent.click(chip);
    fireEvent.click(chip, { ctrlKey: true });
    fireEvent.click(chip, { metaKey: true });
    expect(onOpen.mock.calls.map(([options]) => options.background)).toEqual([false, true, true]);
  });
});

describe("StatusBarItem", () => {
  it("is plain text without an action, a button with one", () => {
    const { rerender, container } = render(<StatusBarItem>main</StatusBarItem>);
    expect(container.querySelector("span.nv-statusbar__item")?.textContent).toBe("main");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<StatusBarItem onClick={() => undefined}>main</StatusBarItem>);
    expect(screen.getByRole("button", { name: "main" })).toBeTruthy();
  });
});

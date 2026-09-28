import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { renderWithMission } from "../diff/test-helpers";
import { AgentApproval, approvalTitleText } from "./AgentApproval";

installDomPolyfills();
afterEach(cleanup);

function approval(workspaceId: string, missionId: string, partial: Partial<Approval> = {}): Approval {
  return {
    id: "00000000-0000-4000-8000-0000000ap001",
    request: { workspaceId, missionId, tool: "run_command", operation: "execute", argv: ["pnpm", "test"] },
    decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle de test." },
    toolCallId: null,
    status: "pending",
    scope: null,
    createdAt: 1,
    decidedAt: null,
    ...partial,
  };
}

/** A composer outside the agent panel, and the panel holding the approval card. */
function renderCard(options: { typing: boolean; external?: boolean }) {
  let card: Approval | null = null;
  const utils = renderWithMission({
    edits: [],
    ui: (missionId) => {
      card = approval("00000000-0000-4000-8000-00000000b001", missionId, options.external ? { request: { workspaceId: "w", missionId, tool: "mcp__github__create-issue", operation: "external" } } : {});
      return (
        <>
          <textarea aria-label="Composer" autoFocus={options.typing} />
          <section data-agent-panel>{card ? <AgentApproval approval={card} /> : null}</section>
        </>
      );
    },
  });
  return { ...utils, card: card as Approval | null };
}

describe("approvalTitleText", () => {
  it("says a process_stop stops the command it names, never that it launches it", () => {
    const stop = approval("w", "m", { request: { workspaceId: "w", missionId: "m", tool: "process_stop", operation: "execute", argv: ["node", "server.js"] } });
    expect(approvalTitleText(stop)).toBe("Nomi veut arrêter");
    expect(approvalTitleText(approval("w", "m"))).toBe("Nomi veut lancer");
  });
});

describe("AgentApproval", () => {
  it("does not take focus from a field the user is typing in", () => {
    renderCard({ typing: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Composer" }));
    expect(screen.getByRole("alertdialog", { name: /Nomi veut lancer/ })).toBeTruthy();
  });

  it("takes focus on appearance when nothing is being typed, and an explicit request always moves it", () => {
    const { store, card } = renderCard({ typing: false });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Autoriser une fois" }));
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    if (!card) throw new Error("no card");
    act(() => {
      store.setState({ approvals: { [card.id]: card } });
      store.getState().focusApproval(card.id);
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Autoriser une fois" }));
  });

  it("marks external actions irreversible and offers no mission-wide approval", () => {
    renderCard({ typing: true, external: true });
    expect(screen.getByText("Cette action ne pourra pas être annulée par NOVA.")).toBeTruthy();
    // An MCP call names the service and tool it acts on (it has no path or host).
    expect(screen.getByRole("alertdialog", { name: "Nomi veut agir hors de NOVA github › create-issue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pour cette mission" })).toBeNull();
    // The shortcut hint does not announce the missing mission-wide shortcut.
    expect(screen.getByText("Ctrl+Entrée : une fois · Échap : refuser")).toBeTruthy();
    expect(screen.queryByText(/pour la mission/)).toBeNull();
  });
});

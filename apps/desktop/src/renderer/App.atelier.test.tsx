// Smoke test of the atelier on the in-memory bridge: open a folder, see its tree, launch a mission
// from the contract sheet, follow its tool cards, answer an approval, read the end card, review.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval, GitStatus, IpcResult, MissionDiff, MissionTask } from "@nova/shared";
import { createAtelierFake } from "./test/atelier-fake";
import { makeModel, testId, VALID_CONNECTION } from "./test/fake-bridge";
import { installDomPolyfills } from "./test/dom";
import { renderApp } from "./test/render-app";

installDomPolyfills();
afterEach(cleanup);

const PATCH = `--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 return a + b;
`;

const GIT: GitStatus = { available: true, branch: "main", upstream: null, ahead: null, behind: null, entries: [], truncated: false };

function setup() {
  const model = makeModel({ id: "vendor/tool-model", name: "Tool Model", supportsTools: true });
  const atelier = createAtelierFake({ git: GIT });
  const overrides = {
    ...atelier.overrides,
    search: {
      files: (): Promise<IpcResult<{ paths: string[]; truncated: boolean }>> =>
        Promise.resolve({ ok: true, value: { paths: ["src/cart.ts", "package.json"], truncated: false } }),
    },
    missions: {
      ...atelier.overrides.missions,
      diff: ({ missionId }: { missionId: string }): Promise<IpcResult<MissionDiff>> =>
        Promise.resolve({
          ok: true,
          value: {
            missionId,
            files: [{ path: "src/cart.ts", change: "modified", beforeHash: "a".repeat(64), currentHash: "b".repeat(64), patch: PATCH, missing: null }],
          },
        }),
    },
  };
  const app = renderApp({
    connection: VALID_CONNECTION,
    settings: { defaultModelId: model.id },
    models: [model],
    atelier: overrides,
  });
  return { ...app, atelier };
}

describe("App atelier", () => {
  it("opens a folder, runs a mission through an approval to its end card, then opens the review", async () => {
    const { atelier, calls, store } = setup();

    // Home → « Ouvrir un dossier » → the file tree of the folder.
    const folderCard = await screen.findByRole("region", { name: "Ouvrir un dossier" });
    await act(async () => {
      fireEvent.click(within(folderCard).getByRole("button", { name: "Ouvrir un dossier…" }));
    });
    expect(calls).toContain("workspace.open");
    expect(await screen.findByRole("treeitem", { name: /package\.json/ })).toBeTruthy();
    expect(screen.getByRole("contentinfo", { name: "Barre d'état" }).textContent).toContain("Branche main");

    // Agent: « Corriger » mode, a goal, then the plan + contract sheet.
    fireEvent.click(screen.getByRole("button", { name: "Confier une mission à Nomi" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Corriger" }));
    // « @ » proposes project files; ↓ then Entrée inserts one without sending the goal.
    const goal = screen.getByRole("textbox", { name: "Objectif de la mission" });
    fireEvent.change(goal, { target: { value: "Le total du panier est faux dans @ca" } });
    expect(await screen.findByRole("button", { name: /src\/cart\.ts/ })).toBeTruthy();
    fireEvent.keyDown(goal, { key: "ArrowDown" });
    fireEvent.keyDown(goal, { key: "ArrowUp" });
    fireEvent.keyDown(goal, { key: "Enter" });
    expect((goal as HTMLTextAreaElement).value).toBe("Le total du panier est faux dans @src/cart.ts ");
    expect(calls).not.toContain("missions.plan");
    fireEvent.click(screen.getByRole("button", { name: /^Ce qui part/ }));
    expect(screen.getByRole("region", { name: "Ce qui part avec ce message" }).textContent).toContain("@src/cart.ts");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    });
    expect(calls).toContain("missions.plan");
    expect(await screen.findByDisplayValue("Reproduire le bug")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lancer la mission" }));
    });
    expect(calls).toContain("missions.start");
    const mission = atelier.mission();
    if (!mission) throw new Error("no mission");
    const missionId = mission.id;
    const journal = await screen.findByRole("list", { name: "Journal de la mission" });

    // Live events: a read, then a command that needs an approval.
    const task: MissionTask = {
      id: testId(),
      missionId,
      seq: 1,
      title: "Reproduire le bug",
      state: "running",
      acceptance: { kind: "test_passes", detail: "pnpm vitest run cart" },
    };
    const readId = testId();
    const commandId = testId();
    const editId = testId();
    const approval: Approval = {
      id: testId(),
      request: { workspaceId: atelier.workspace.id, missionId, tool: "run_command", operation: "execute", argv: ["pnpm", "vitest", "run", "cart"] },
      decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle de test." },
      toolCallId: commandId,
      status: "pending",
      scope: null,
      createdAt: 2_500,
      decidedAt: null,
    };
    act(() => {
      atelier.emit({ type: "mission.plan", missionId, summary: "Deux étapes", tasks: [task] });
      atelier.emit({
        type: "tool.requested",
        missionId,
        taskId: task.id,
        call: { id: readId, name: "read_file", operation: "read", argumentsPreview: "{}", path: "src/cart.ts", host: null, argv: null },
      });
      atelier.emit({ type: "tool.started", missionId, callId: readId, isolationLevel: null });
      atelier.emit({
        type: "tool.finished",
        missionId,
        callId: readId,
        state: "succeeded",
        durationMs: 4,
        display: { kind: "file_read", path: "src/cart.ts", startLine: 1, endLine: 3, totalLines: 3 },
      });
      atelier.emit({
        type: "tool.requested",
        missionId,
        taskId: task.id,
        call: { id: commandId, name: "run_command", operation: "execute", argumentsPreview: "{}", path: null, host: null, argv: approval.request.argv ?? null },
      });
      atelier.emit({ type: "approval.requested", missionId, approval });
    });
    expect(within(journal).getByText("src/cart.ts:1-3")).toBeTruthy();
    const card = await screen.findByRole("alertdialog", { name: /Nomi veut lancer/ });
    expect(screen.getByRole("contentinfo", { name: "Barre d'état" }).textContent).toContain("1 approbation en attente");

    // Ctrl+Entrée in the card approves once.
    await act(async () => {
      fireEvent.keyDown(card, { key: "Enter", ctrlKey: true });
    });
    expect(atelier.decisions).toEqual([{ approvalId: approval.id, decision: "approve", scope: "once" }]);

    // The mission edits a file, proves the test, and succeeds.
    act(() => {
      atelier.emit({ type: "approval.resolved", missionId, approval: { ...approval, status: "approved", scope: "once", decidedAt: 3_000 } });
      atelier.emit({ type: "tool.started", missionId, callId: commandId, isolationLevel: "L0" });
      atelier.emit({
        type: "tool.finished",
        missionId,
        callId: commandId,
        state: "succeeded",
        durationMs: 800,
        display: { kind: "tests", runner: "vitest", passed: 3, failed: 0, skipped: 0, exitCode: 0, proofId: null },
      });
      atelier.emit({
        type: "tool.requested",
        missionId,
        taskId: task.id,
        call: { id: editId, name: "edit_file", operation: "write", argumentsPreview: "{}", path: "src/cart.ts", host: null, argv: null },
      });
      atelier.emit({
        type: "tool.finished",
        missionId,
        callId: editId,
        state: "succeeded",
        durationMs: 5,
        display: { kind: "file_change", change: "modified", path: "src/cart.ts", fromPath: null, additions: 1, deletions: 1, checkpointId: null },
      });
      atelier.emit({ type: "task.updated", missionId, task: { ...task, state: "verified" } });
      atelier.emit({ type: "mission.succeeded", missionId, summary: "Le total tient compte de la remise." });
    });

    const end = await screen.findByRole("region", { name: "Mission terminée" });
    expect(within(end).getByText("Le total tient compte de la remise.")).toBeTruthy();
    expect(within(end).getByRole("heading", { name: "Vérifié" })).toBeTruthy();
    expect(within(end).getByText(/Reproduire le bug/)).toBeTruthy();
    expect(within(end).getByText(/estimation : /)).toBeTruthy();

    // « Relire les changements » opens the review in the workbench, from the mission's own diff.
    await act(async () => {
      fireEvent.click(within(end).getByRole("button", { name: "Relire les changements" }));
    });
    expect(store.getState().ui.activeDoc).toBe(`diff:${missionId}`);
    expect(await screen.findByRole("region", { name: "Relecture des changements" })).toBeTruthy();
    expect(calls).toContain("missions.diff");
  }, 30_000);
});

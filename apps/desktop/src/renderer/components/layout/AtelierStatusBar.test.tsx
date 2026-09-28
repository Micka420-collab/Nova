// The status bar, the home card and the tree read ONE Git status: the explorer's, re-read on file
// events. A file saved in the editor (or changed outside) must show in the status bar's counts.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesEvent, GitStatus, IpcResult, MissionEvent } from "@nova/shared";
import { createAtelierFake } from "../../test/atelier-fake";
import { VALID_CONNECTION } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { renderApp } from "../../test/render-app";

installDomPolyfills();
afterEach(cleanup);

const CLEAN: GitStatus = { available: true, branch: "main", upstream: null, ahead: null, behind: null, entries: [], truncated: false };

describe("AtelierStatusBar", () => {
  it("counts a file changed on disk after the folder was opened (file events refresh Git status)", async () => {
    let git: GitStatus = CLEAN;
    let pushFiles: ((event: FilesEvent) => void) | null = null;
    const atelier = createAtelierFake({ git: CLEAN });
    renderApp({
      connection: VALID_CONNECTION,
      atelier: {
        ...atelier.overrides,
        git: { ...atelier.overrides.git, status: (): Promise<IpcResult<GitStatus>> => Promise.resolve({ ok: true, value: git }) },
        files: {
          ...atelier.overrides.files,
          onEvent: (listener: (event: FilesEvent) => void) => {
            pushFiles = listener;
            return () => undefined;
          },
        },
      },
    });
    const folderCard = await screen.findByRole("region", { name: "Ouvrir un dossier" });
    await act(async () => {
      fireEvent.click(within(folderCard).getByRole("button", { name: "Ouvrir un dossier…" }));
    });
    const statusBar = screen.getByRole("contentinfo", { name: "Barre d'état" });
    await screen.findByText("aucun changement");
    expect(statusBar.textContent).toContain("Branche main");

    git = { ...CLEAN, entries: [{ path: "src/cart.ts", index: "unmodified", worktree: "modified", origPath: null }] };
    await act(async () => {
      pushFiles?.({ type: "changes", workspaceId: atelier.workspace.id, changes: [{ kind: "changed", path: "src/cart.ts", isDirectory: false }] });
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(statusBar.textContent).toContain("1 fichier modifié");
  });

  it("re-reads Git status when a mission review changes the repository (no file event for .git)", async () => {
    let git: GitStatus = CLEAN;
    let pushMission: ((event: MissionEvent) => void) | null = null;
    const atelier = createAtelierFake({ git: CLEAN });
    renderApp({
      connection: VALID_CONNECTION,
      atelier: {
        ...atelier.overrides,
        git: { ...atelier.overrides.git, status: (): Promise<IpcResult<GitStatus>> => Promise.resolve({ ok: true, value: git }) },
        missions: {
          ...atelier.overrides.missions,
          onEvent: (listener: (event: MissionEvent) => void) => {
            pushMission = listener;
            return () => undefined;
          },
        },
      },
    });
    const folderCard = await screen.findByRole("region", { name: "Ouvrir un dossier" });
    await act(async () => {
      fireEvent.click(within(folderCard).getByRole("button", { name: "Ouvrir un dossier…" }));
    });
    const statusBar = screen.getByRole("contentinfo", { name: "Barre d'état" });
    await screen.findByText("aucun changement");
    git = { ...CLEAN, entries: [{ path: "src/cart.ts", index: "modified", worktree: "unmodified", origPath: null }] };
    await act(async () => {
      pushMission?.({ id: "e1", missionId: "m1", seq: 3, at: 3, type: "review.decided", decisions: [] });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(statusBar.textContent).toContain("1 fichier modifié");
  });

  it("names a test runner NOVA does not know by its command on the home card, never « other »", async () => {
    const atelier = createAtelierFake({ git: CLEAN });
    renderApp({
      connection: VALID_CONNECTION,
      atelier: {
        ...atelier.overrides,
        workspace: {
          ...atelier.overrides.workspace,
          facts: () =>
            Promise.resolve({
              ok: true,
              value: {
                workspaceId: atelier.workspace.id,
                detectedAt: 1,
                packageManager: "npm",
                languages: ["javascript"],
                frameworks: [],
                testRunner: { name: "other", command: ["npm", "test"] },
                devCommand: null,
                buildCommand: null,
                git: true,
                instructionFiles: [],
              },
            }),
        },
      },
    });
    const folderCard = await screen.findByRole("region", { name: "Ouvrir un dossier" });
    await act(async () => {
      fireEvent.click(within(folderCard).getByRole("button", { name: "Ouvrir un dossier…" }));
    });
    expect(await screen.findByText("Projet détecté : javascript · npm test")).toBeTruthy();
    expect(screen.queryByText(/other/)).toBeNull();
  });
});

// The status bar, the home card and the tree read ONE Git status: the explorer's, re-read on file
// events. A file saved in the editor (or changed outside) must show in the status bar's counts.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FilesEvent, GitStatus, IpcResult } from "@nova/shared";
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
});

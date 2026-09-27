import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Checkpoint, IpcResult, RestoreFileResult } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { CheckpointsView } from "./CheckpointsView";
import { renderWithMission } from "./test-helpers";

installDomPolyfills();
afterEach(cleanup);

const HASH = "a".repeat(64);

function checkpoint(workspaceId: string): Checkpoint {
  return {
    id: "00000000-0000-4000-8000-00000000aaaa",
    workspaceId,
    missionId: null,
    label: "avant mission portfolio",
    reason: "tool_write",
    createdAt: Date.now() - 60_000,
    files: [
      { checkpointId: "00000000-0000-4000-8000-00000000aaaa", path: "index.html", beforeHash: HASH, afterHash: HASH, userHashSeen: null },
      { checkpointId: "00000000-0000-4000-8000-00000000aaaa", path: "new.css", beforeHash: null, afterHash: HASH, userHashSeen: null },
    ],
  };
}

describe("CheckpointsView", () => {
  it("lists points and explains a conflict without overwriting anything", async () => {
    const restored: string[] = [];
    const { store } = renderWithMission({
      edits: [],
      overrides: (base) => ({
        ...base,
        checkpoints: {
          ...base.checkpoints,
          list: ({ workspaceId }) => Promise.resolve({ ok: true, value: [checkpoint(workspaceId)] }),
          restoreFile: ({ path }): Promise<IpcResult<RestoreFileResult>> => {
            restored.push(path);
            return Promise.resolve({ ok: true, value: { status: "conflict", path, currentHash: null, expectedHash: HASH } });
          },
        },
      }),
      ui: () => <CheckpointsView missionId={null} />,
    });
    expect(await screen.findByRole("heading", { name: "avant mission portfolio" })).toBeTruthy();
    expect(screen.getByText("avant une écriture de Nomi")).toBeTruthy();
    expect(screen.getByText("créé")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restaurer index.html" }));
    });
    expect(restored).toEqual(["index.html"]);
    const dialog = screen.getByRole("dialog", { name: "Ce fichier a changé depuis ce point de reprise" });
    expect(within(dialog).getByText(/Rien n'a été écrasé/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Comparer" }));
    expect(store.getState().ui.reveal?.path).toBe("index.html");
  });

  it("confirms a return with the exact files, then reports the safety point", async () => {
    renderWithMission({
      edits: [],
      overrides: (base) => ({
        ...base,
        checkpoints: {
          ...base.checkpoints,
          list: ({ workspaceId }) => Promise.resolve({ ok: true, value: [checkpoint(workspaceId)] }),
        },
      }),
      ui: () => <CheckpointsView missionId={null} />,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revenir à ce point" }));
    const dialog = screen.getByRole("dialog", { name: "Revenir à « avant mission portfolio » ?" });
    expect(within(dialog).getByText("index.html")).toBeTruthy();
    expect(within(dialog).getByText(/avant retour/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revenir" }));
    });
    expect(await screen.findByText(/ce retour est lui-même annulable/)).toBeTruthy();
  });

  it("says when there is no point yet", async () => {
    renderWithMission({ edits: [], ui: () => <CheckpointsView missionId={null} /> });
    expect(await screen.findByText("Aucun point de reprise pour l'instant.")).toBeTruthy();
  });
});

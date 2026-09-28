import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NovaIpcError, type Mission, type MissionLink, type MissionTreeNode, type NovaApi } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { createSubmissionsStore, type SubmissionsClient } from "../../state/submissions-slice";
import { SubmissionTree } from "./SubmissionTree";

installDomPolyfills();
afterEach(cleanup);

type SubmissionsApi = NovaApi["submissions"];

const mission = (id: string, over: Partial<Mission> = {}): Mission => ({
  id,
  workspaceId: "w",
  conversationId: null,
  title: id,
  goal: "g",
  mode: "build",
  state: "succeeded",
  modelId: "acme/m",
  createdAt: 1,
  startedAt: 1,
  endedAt: 2,
  updatedAt: 2,
  ...over,
});
const link = (child: string, over: Partial<MissionLink> = {}): MissionLink => ({
  childMissionId: child,
  parentMissionId: "parent",
  kind: "submission",
  forkSeq: null,
  depth: 1,
  reservedUsd: 0.2,
  worktree: child,
  integration: "pending",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const parentTree = (children: MissionTreeNode["children"]): MissionTreeNode => ({ mission: mission("parent", { state: "running" }), link: null, children });

function setup(api: Partial<SubmissionsClient["submissions"]>, missionId = "parent") {
  const client: SubmissionsClient = {
    submissions: {
      tree: vi.fn<SubmissionsApi["tree"]>(async () => parentTree([])),
      integrate: vi.fn<SubmissionsApi["integrate"]>(async () => parentTree([])),
      discard: vi.fn<SubmissionsApi["discard"]>(async () => parentTree([])),
      ...api,
    },
  };
  const store = createSubmissionsStore(client);
  const opened: string[] = [];
  render(<SubmissionTree store={store} missionId={missionId} onOpenMission={(id) => opened.push(id)} />);
  return { client, store, opened };
}

describe("SubmissionTree", () => {
  it("shows each child's state, budget and integration, and integrates with a visible result", async () => {
    let integrated = false;
    const writer = { mission: mission("w1", { title: "Écrire les tests" }), link: link("w1") };
    const reader = { mission: mission("r1", { title: "Explorer le panier", state: "running", mode: "understand" }), link: link("r1", { worktree: null, integration: "not_needed" }) };
    const { client, opened } = setup({
      tree: vi.fn<SubmissionsApi["tree"]>(async () => parentTree([writer, reader])),
      integrate: vi.fn<SubmissionsApi["integrate"]>(async () => {
        integrated = true;
        return parentTree([{ ...writer, link: link("w1", { integration: "integrated", worktree: null }) }, reader]);
      }),
    });
    expect(await screen.findByText("Sous-missions (2)")).toBeTruthy();
    expect(screen.getByText("Écrire les tests")).toBeTruthy();
    expect(screen.getByText("en attente d’intégration")).toBeTruthy();
    expect(screen.getAllByText(/budget réservé 0,20/)).toHaveLength(2);
    expect(screen.getByText(/lecture seule/)).toBeTruthy();
    expect(screen.getByText(/modifie des fichiers \(copie de travail\)/)).toBeTruthy();
    // The read-only running child can only be opened or abandoned.
    expect(screen.queryByRole("button", { name: "Intégrer la sous-mission « Explorer le panier » au projet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Intégrer la sous-mission « Écrire les tests » au projet" }));
    await waitFor(() => expect(screen.getByText("intégrée")).toBeTruthy());
    expect(integrated).toBe(true);
    expect(client.submissions.integrate).toHaveBeenCalledWith({ childMissionId: "w1" });
    expect(screen.getByText(/avec un point de restauration/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la sous-mission « Explorer le panier »" }));
    expect(opened).toEqual(["r1"]);
  });

  it("explains a refused integration in French on the row", async () => {
    setup({
      tree: vi.fn<SubmissionsApi["tree"]>(async () => parentTree([{ mission: mission("w1", { title: "Écrire" }), link: link("w1") }])),
      integrate: vi.fn<SubmissionsApi["integrate"]>(async () => Promise.reject(new NovaIpcError({ code: "unavailable", message: "no test command" }))),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Intégrer la sous-mission « Écrire » au projet" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Rien n’entre dans le projet sans tests verts");
  });

  it("asks before abandoning, then shows the discarded state", async () => {
    const child = { mission: mission("w1", { title: "Écrire", state: "running" }), link: link("w1", { integration: null }) };
    const { client } = setup({
      tree: vi.fn<SubmissionsApi["tree"]>(async () => parentTree([child])),
      discard: vi.fn<SubmissionsApi["discard"]>(async () => parentTree([{ mission: { ...child.mission, state: "cancelled" }, link: link("w1", { integration: "discarded", worktree: null }) }])),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Abandonner la sous-mission « Écrire »" }));
    expect(screen.getByText(/sa copie de travail est supprimée/)).toBeTruthy();
    expect(client.submissions.discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Abandonner" }));
    await waitFor(() => expect(screen.getByText("abandonnée")).toBeTruthy());
    expect(client.submissions.discard).toHaveBeenCalledWith({ childMissionId: "w1" });
  });

  it("renders nothing when the group is not wired or the mission has no child", async () => {
    const { client } = setup({ tree: vi.fn<SubmissionsApi["tree"]>(async () => Promise.reject(new NovaIpcError({ code: "unavailable", message: "x" }))) });
    await waitFor(() => expect(client.submissions.tree).toHaveBeenCalled());
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    setup({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Sous-missions/)).toBeNull();
  });

  it("shows a child's origin on its own card", async () => {
    const { opened } = setup({ tree: vi.fn<SubmissionsApi["tree"]>(async () => ({ mission: mission("w1"), link: link("w1"), children: [] })) }, "w1");
    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir la mission parente" }));
    expect(opened).toEqual(["parent"]);
  });
});

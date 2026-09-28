import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcResult, MissionDiff, ReviewDecision, ReviewResult } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { DiffReview } from "./DiffReview";
import { renderWithMission } from "./test-helpers";

installDomPolyfills();
afterEach(cleanup);

const PATCH = `--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,3 +1,3 @@ export function total()
 const a = 1;
-const b = 2;
+const b = 3;
 return a + b;
@@ -10,2 +10,3 @@
 x
+// commentaire
 y
`;

function withMissionDiff(reviewed: ReviewDecision[][], result?: (decisions: ReviewDecision[]) => ReviewResult) {
  return renderWithMission({
    edits: [{ path: "src/cart.ts", change: "modified", additions: 2, deletions: 1 }],
    displayMode: "expert",
    overrides: (base) => ({
      ...base,
      missions: {
        ...base.missions,
        diff: ({ missionId }): Promise<IpcResult<MissionDiff>> =>
          Promise.resolve({
            ok: true,
            value: {
              missionId,
              files: [{ path: "src/cart.ts", change: "modified", beforeHash: null, currentHash: null, patch: PATCH, missing: null }],
            },
          }),
        review: ({ decisions }): Promise<IpcResult<ReviewResult>> => {
          reviewed.push(decisions);
          return Promise.resolve({ ok: true, value: result ? result(decisions) : { applied: decisions, conflicts: [] } });
        },
      },
    }),
    ui: (missionId) => <DiffReview missionId={missionId} />,
  });
}

describe("DiffReview", () => {
  it("reviews hunk by hunk with the keyboard and sends one decision per hunk", async () => {
    const reviewed: ReviewDecision[][] = [];
    withMissionDiff(reviewed);
    const region = await screen.findByRole("region", { name: "Relecture des changements" });
    expect(screen.getByText(/Diff — 1 fichier · \+2 −1 · mission « Corriger le panier »/)).toBeTruthy();
    expect(within(region).getByRole("region", { name: "bloc 1 sur 2, lignes 1 à 3" })).toBeTruthy();
    // Added / removed lines carry a text prefix, not only a color.
    expect(within(region).getAllByText("ajouté", { exact: false }).length).toBeGreaterThan(0);

    region.focus();
    fireEvent.keyDown(region, { key: "a" });
    fireEvent.keyDown(region, { key: "j" });
    fireEvent.keyDown(region, { key: "x" });
    expect((await screen.findByRole("status")).textContent).toBe("Annulé");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Appliquer 2 décisions" }));
    });
    expect(reviewed).toEqual([
      [
        { path: "src/cart.ts", hunkIndex: 0, decision: "kept" },
        { path: "src/cart.ts", hunkIndex: 1, decision: "reverted" },
      ],
    ]);
    // A hunk revert renumbers the hunks: the diff is loaded again (this fake still returns both).
    const reloaded = await screen.findByRole("region", { name: "Relecture des changements" });
    expect(within(reloaded).getByRole("region", { name: "bloc 1 sur 2, lignes 1 à 3" })).toBeTruthy();
  });

  it("reviews the files main's diff has even when the loaded (cut) log names none of them", async () => {
    const reviewed: ReviewDecision[][] = [];
    renderWithMission({
      edits: [],
      overrides: (base) => ({
        ...base,
        missions: {
          ...base.missions,
          diff: ({ missionId }): Promise<IpcResult<MissionDiff>> =>
            Promise.resolve({
              ok: true,
              value: { missionId, files: [{ path: "src/early.ts", change: "modified", beforeHash: null, currentHash: null, patch: PATCH.replaceAll("cart", "early"), missing: null }] },
            }),
          review: ({ decisions }): Promise<IpcResult<ReviewResult>> => {
            reviewed.push(decisions);
            return Promise.resolve({ ok: true, value: { applied: decisions, conflicts: [] } });
          },
        },
      }),
      ui: (missionId) => <DiffReview missionId={missionId} />,
    });
    await screen.findByText(/^Diff — 1 fichier/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tout garder" }));
    });
    expect(reviewed).toEqual([[{ path: "src/early.ts", hunkIndex: null, decision: "kept" }]]);
  });

  it("reloads the diff after a hunk revert, so the next decision names the hunk that is really there", async () => {
    const hunk = (line: number, text: string) => `@@ -${line},2 +${line},3 @@\n a${line}\n+${text}\n b${line}\n`;
    const all = [hunk(1, "// H0"), hunk(20, "// H1"), hunk(40, "// H2")];
    let hunks = all;
    const reviewed: ReviewDecision[][] = [];
    renderWithMission({
      edits: [{ path: "src/cart.ts", change: "modified", additions: 3, deletions: 0 }],
      displayMode: "expert",
      overrides: (base) => ({
        ...base,
        missions: {
          ...base.missions,
          diff: ({ missionId }): Promise<IpcResult<MissionDiff>> =>
            Promise.resolve({
              ok: true,
              value: {
                missionId,
                files: [{ path: "src/cart.ts", change: "modified", beforeHash: null, currentHash: null, patch: `--- a/src/cart.ts\n+++ b/src/cart.ts\n${hunks.join("")}`, missing: null }],
              },
            }),
          // Like main: reverting hunks rewrites the file, so diff(before → now) loses them.
          review: ({ decisions }): Promise<IpcResult<ReviewResult>> => {
            reviewed.push(decisions);
            const reverted = new Set(decisions.filter((item) => item.decision === "reverted").map((item) => item.hunkIndex));
            hunks = hunks.filter((_, index) => !reverted.has(index));
            return Promise.resolve({ ok: true, value: { applied: decisions, conflicts: [] } });
          },
        },
      }),
      ui: (missionId) => <DiffReview missionId={missionId} />,
    });
    let region = await screen.findByRole("region", { name: "Relecture des changements" });
    region.focus();
    fireEvent.keyDown(region, { key: "x" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Appliquer 1 décision" }));
    });
    region = await screen.findByRole("region", { name: "Relecture des changements" });
    expect(within(region).getByRole("region", { name: /^bloc 1 sur 2, lignes 20/ })).toBeTruthy();
    // No stale « annulé » mark lands on the hunk that took position 0.
    expect(within(region).queryByText("annulé")).toBeNull();
    region.focus();
    fireEvent.keyDown(region, { key: "x" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Appliquer 1 décision" }));
    });
    expect(reviewed).toEqual([
      [{ path: "src/cart.ts", hunkIndex: 0, decision: "reverted" }],
      [{ path: "src/cart.ts", hunkIndex: 0, decision: "reverted" }],
    ]);
    expect(hunks).toEqual([all[2]]);
  });

  it("shows a conflict from main instead of claiming the revert happened", async () => {
    const reviewed: ReviewDecision[][] = [];
    withMissionDiff(reviewed, (decisions) => ({ applied: [], conflicts: decisions.map(({ path, hunkIndex }) => ({ path, hunkIndex })) }));
    await screen.findByRole("region", { name: "Relecture des changements" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restaurer" }));
    });
    expect(reviewed).toEqual([[{ path: "src/cart.ts", hunkIndex: null, decision: "reverted" }]]);
    expect(screen.getAllByText("Ce fichier a changé depuis la mission · rien n'a été écrasé.").length).toBeGreaterThan(0);
  });

  it("asks before cancelling everything and lists the files", async () => {
    const reviewed: ReviewDecision[][] = [];
    withMissionDiff(reviewed);
    await screen.findByRole("region", { name: "Relecture des changements" });
    fireEvent.click(screen.getByRole("button", { name: "Tout annuler" }));
    const dialog = screen.getByRole("dialog", { name: "Annuler tous les changements de la mission ?" });
    expect(within(dialog).getByText("src/cart.ts")).toBeTruthy();
    expect(reviewed).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Tout annuler" }));
    });
    expect(reviewed).toEqual([[{ path: "src/cart.ts", hunkIndex: null, decision: "reverted" }]]);
  });

  it("in Créer, summarizes per file with its real proof, and says when nothing verified it", async () => {
    renderWithMission({
      edits: [
        { path: "src/cart.ts", change: "modified", additions: 2, deletions: 1 },
        { path: "src/new.ts", change: "created", additions: 4, deletions: 0 },
      ],
      git: false,
      ui: (missionId) => <DiffReview missionId={missionId} />,
    });
    await screen.findByRole("region", { name: "Relecture des changements" });
    expect(screen.getAllByText("Non vérifié")).toHaveLength(2);
    expect(screen.getAllByText("aucun test")).toHaveLength(2);
    // A created file is removed, not "restored".
    expect(screen.getByRole("button", { name: "Supprimer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restaurer" })).toBeTruthy();
  });

  it("marks a file verified only by a recorded passing test", async () => {
    renderWithMission({
      edits: [{ path: "src/cart.ts", change: "modified", additions: 2, deletions: 1 }],
      git: false,
      proofs: (missionId) => [
        {
          id: "p1",
          missionId,
          taskId: null,
          toolCallId: null,
          kind: "test",
          command: ["pnpm", "vitest"],
          exitCode: 0,
          summary: "pnpm vitest run cart",
          outputRef: null,
          createdAt: 1,
        },
      ],
      ui: (missionId) => <DiffReview missionId={missionId} />,
    });
    await screen.findByRole("region", { name: "Relecture des changements" });
    // The proof has no task linking it to the file: no false "verified".
    expect(screen.getByText("Non vérifié")).toBeTruthy();
  });

  it("says when the mission changed nothing", async () => {
    renderWithMission({ edits: [], ui: (missionId) => <DiffReview missionId={missionId} /> });
    expect(await screen.findByText("Aucun changement à relire")).toBeTruthy();
  });
});

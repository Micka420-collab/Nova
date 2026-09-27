import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcResult, ReviewDecision, ReviewResult } from "@nova/shared";
import { installDomPolyfills } from "../../test/dom";
import { DiffReview } from "./DiffReview";
import { renderWithMission } from "./test-helpers";

installDomPolyfills();
afterEach(cleanup);

const PATCH = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
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

function withGitDiff(reviewed: ReviewDecision[][], result?: (decisions: ReviewDecision[]) => ReviewResult) {
  return renderWithMission({
    edits: [{ path: "src/cart.ts", change: "modified", additions: 2, deletions: 1 }],
    displayMode: "expert",
    overrides: (base) => ({
      ...base,
      git: { ...base.git, diff: () => Promise.resolve({ ok: true, value: { patch: PATCH, truncated: false } }) },
      missions: {
        ...base.missions,
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
    withGitDiff(reviewed);
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
    // Once applied, the hunks show the recorded decision.
    expect(within(region).getByText("gardé")).toBeTruthy();
    expect(within(region).getByText("annulé")).toBeTruthy();
  });

  it("shows a conflict from main instead of claiming the revert happened", async () => {
    const reviewed: ReviewDecision[][] = [];
    withGitDiff(reviewed, (decisions) => ({ applied: [], conflicts: decisions.map(({ path, hunkIndex }) => ({ path, hunkIndex })) }));
    await screen.findByRole("region", { name: "Relecture des changements" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restaurer" }));
    });
    expect(reviewed).toEqual([[{ path: "src/cart.ts", hunkIndex: null, decision: "reverted" }]]);
    expect(screen.getAllByText("Ce fichier a changé depuis la mission · rien n'a été écrasé.").length).toBeGreaterThan(0);
  });

  it("asks before cancelling everything and lists the files", async () => {
    const reviewed: ReviewDecision[][] = [];
    withGitDiff(reviewed);
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
    expect(await screen.findByText(/Diff indisponible sans Git/)).toBeTruthy();
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

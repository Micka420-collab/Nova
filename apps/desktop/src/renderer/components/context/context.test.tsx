// L2 UI: the gauge tells real figures (or « inconnu »), a summary is shown as a summary and only
// applied by an explicit click, the model switch lists catalog models, and no control appears
// while main answers `unavailable` for the context group.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNovaClient,
  type CompactionSummary,
  type CompactionDecideRequest,
  type ContextUsage,
  type HandoffRequest,
  type Mission,
  type MissionEvent,
} from "@nova/shared";
import { Toaster } from "@nova/ui";
import { installDomPolyfills } from "../../test/dom";
import { makeContract } from "../../test/atelier-fake";
import { createFakeBridge, makeModel, type HarnessOverrides } from "../../test/fake-bridge";
import { AppProvider } from "../../state/context";
import { createAppStore } from "../../state/store";
import { applyMissionEvent, type MissionView } from "../missions/timeline";
import { ContextGauge } from "./ContextGauge";
import { ConversationContextPanel } from "./ConversationContextPanel";
import { MissionContextPanel } from "./MissionContextPanel";
import { switchCandidates } from "./ModelSwitcher";
import { SummaryCard } from "./SummaryCard";
import { parseCompactCommand } from "./compact-command";

installDomPolyfills();
afterEach(cleanup);

const MISSION_ID = "00000000-0000-4000-8000-00000000f001";
const target = { kind: "mission" as const, missionId: MISSION_ID };
const usage = (partial: Partial<ContextUsage> = {}): ContextUsage => ({
  target, modelId: "vendor/a", usedTokens: 850, contextLength: 1_000, ratio: 0.85, source: "provider_usage", proposalDue: true, measuredAt: 1, ...partial,
});
const proposal: CompactionSummary = {
  id: "00000000-0000-4000-8000-00000000f002", target, kind: "compaction", reason: "proposed", status: "proposed",
  summary: "Le test du panier échoue sur les remises.", summarizerModelId: "vendor/a", fromModelId: null, toModelId: null, coveredUntilSeq: 4,
  tokensBefore: 850, tokensAfter: 120, pruned: [{ toolCallId: "c1", tool: "run_tests", originalChars: 40_000, keptChars: 3_000, artifactId: null }],
  costUsd: 0.002, createdAt: 10, decidedAt: null,
};

describe("ContextGauge", () => {
  it("shows the share of the context, where NOVA proposes, and offers a summary when due", () => {
    const onCompact = vi.fn<() => void>();
    render(<ContextGauge usage={usage()} onCompact={onCompact} />);
    expect((screen.getByRole("meter", { name: "Contexte utilisé" }) as HTMLMeterElement).value).toBeCloseTo(0.85);
    expect(screen.getByText("85 % · mesuré par le fournisseur")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Résumer maintenant" }));
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("says « inconnu » and that nothing is proposed when the model's context length is unknown", () => {
    render(<ContextGauge usage={usage({ contextLength: null, ratio: null, usedTokens: null, source: "unknown", proposalDue: false })} onCompact={() => undefined} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("inconnu")).toBeTruthy();
    expect(screen.getByText(/NOVA ne proposera pas de résumé automatiquement/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("SummaryCard", () => {
  it("quotes the summary as a summary, lists the pruned outputs, and decides only on click", () => {
    const onApply = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    render(<SummaryCard summary={proposal} onApply={onApply} onDismiss={onDismiss} />);
    expect(screen.getByRole("article", { name: "Résumé proposé" })).toBeTruthy();
    expect(screen.getByText("Ceci est un résumé, pas une réponse du modèle.")).toBeTruthy();
    expect(screen.getByText("Écrit par vendor/a")).toBeTruthy();
    expect(screen.getByText(proposal.summary).tagName).toBe("BLOCKQUOTE");
    expect(screen.getByText(/run_tests : 40[\s  ]000 → 3[\s  ]000 caractères/)).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));
    fireEvent.click(screen.getByRole("button", { name: "Écarter" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("says a proposal of an ended mission was not applied, with no decision offered", () => {
    render(<SummaryCard summary={proposal} expired onApply={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByText(/Non appliqué : la mission s’est terminée/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no decision once applied", () => {
    render(<SummaryCard summary={{ ...proposal, status: "applied", decidedAt: 11 }} onApply={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByRole("article", { name: "Résumé appliqué" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("helpers", () => {
  it("lists only other catalog models that accept tools", () => {
    const models = [makeModel({ id: "vendor/a", supportsTools: true }), makeModel({ id: "vendor/c", supportsTools: false }), makeModel({ id: "vendor/b", supportsTools: null })];
    expect(switchCandidates(models, "vendor/a").map((model) => model.id)).toEqual(["vendor/b"]);
  });

  it("parses /compact with optional instructions and refuses over-long ones instead of cutting them", () => {
    expect(parseCompactCommand("/compact")).toEqual({ kind: "compact", instructions: null });
    expect(parseCompactCommand("  /compact garder les commandes  ")).toEqual({ kind: "compact", instructions: "garder les commandes" });
    expect(parseCompactCommand("/compacter")).toBeNull();
    expect(parseCompactCommand("résume /compact")).toBeNull();
    expect(parseCompactCommand(`/compact ${"x".repeat(2_001)}`)).toEqual({ kind: "too_long", max: 2_000 });
  });
});

function missionView(events: MissionEvent[]): MissionView {
  const view = events.reduce<MissionView | undefined>((current, event) => applyMissionEvent(current, event), undefined);
  if (!view) throw new Error("no view");
  return view;
}

function renderPanel(harness: HarnessOverrides, view: MissionView) {
  const fake = createFakeBridge({ harness });
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  store.setState({
    catalog: {
      status: "ready",
      data: { providerId: "openrouter", models: [makeModel({ id: "vendor/a", supportsTools: true }), makeModel({ id: "vendor/b", supportsTools: true })], fetchedAt: 1, source: "cache", refreshError: null },
      error: null,
    },
  });
  render(
    <AppProvider store={store} client={client}>
      <Toaster>
        <MissionContextPanel view={view} />
      </Toaster>
    </AppProvider>,
  );
  return fake;
}

describe("MissionContextPanel", () => {
  const mission: Mission = {
    id: MISSION_ID, workspaceId: "00000000-0000-4000-8000-00000000f010", conversationId: null, title: "Panier", goal: "Corriger le panier",
    mode: "fix", state: "running", modelId: "vendor/a", createdAt: 1, startedAt: 1, endedAt: null, updatedAt: 1,
  };
  const view = (): MissionView =>
    missionView([
      { id: "e1", missionId: MISSION_ID, seq: 1, at: 1, type: "mission.created", mission, contract: makeContract(mission.workspaceId) },
      { id: "e2", missionId: MISSION_ID, seq: 0, at: 2, type: "context.usage", usage: usage() },
      { id: "e3", missionId: MISSION_ID, seq: 2, at: 3, type: "compaction.proposed", summary: proposal },
    ]);

  it("shows nothing while main answers unavailable for the context group", async () => {
    renderPanel({}, view());
    await act(async () => undefined);
    expect(screen.queryByText("Résumé proposé")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("applies a proposal and switches model only through the user's clicks", async () => {
    const decided: CompactionDecideRequest[] = [];
    const handoffs: HandoffRequest[] = [];
    renderPanel(
      {
        context: {
          usage: async () => ({ ok: true, value: usage() }),
          list: async () => ({ ok: true, value: [proposal] }),
          decide: async (req) => {
            decided.push(req);
            return { ok: true, value: { ...proposal, status: "applied", decidedAt: 12 } };
          },
          handoff: async (req) => {
            handoffs.push(req);
            return {
              ok: true,
              value: { summaryId: "00000000-0000-4000-8000-00000000f003", missionId: MISSION_ID, fromModelId: "vendor/a", toModelId: req.toModelId, goal: "Corriger le panier", done: [], remaining: [], decisions: [], filesTouched: [], openQuestions: [], createdAt: 20 },
            };
          },
        },
      },
      view(),
    );
    await screen.findByRole("article", { name: "Résumé proposé" });
    expect(decided).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));
    await screen.findByRole("article", { name: "Résumé appliqué" });
    expect(decided).toEqual([{ summaryId: proposal.id, decision: "apply" }]);

    fireEvent.click(screen.getByRole("button", { name: "Changer de modèle" }));
    expect(screen.getByText(/il ne reçoit aucun état interne de l’ancien/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Nouveau modèle" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Changer" }));
    await screen.findByText("Dossier prêt : vendor/b prend la suite au prochain appel.");
    expect(handoffs).toEqual([{ missionId: MISSION_ID, toModelId: "vendor/b" }]);
  });
});

describe("ConversationContextPanel", () => {
  const CONV = "00000000-0000-4000-8000-00000000f020";
  const convTarget = { kind: "conversation" as const, conversationId: CONV };

  it("asks for a summary past the threshold and shows it for a decision", async () => {
    const compacts: string[] = [];
    let summaries: CompactionSummary[] = [];
    const fake = createFakeBridge({
      harness: {
        context: {
          usage: async () => ({ ok: true, value: usage({ target: convTarget }) }),
          list: async () => ({ ok: true, value: summaries }),
          compact: async (req) => {
            compacts.push(req.modelId);
            const created = { ...proposal, target: convTarget, reason: "manual" as const };
            summaries = [created];
            return { ok: true, value: created };
          },
        },
      },
    });
    const client = createNovaClient(fake.bridge);
    render(
      <AppProvider store={createAppStore(client)} client={client}>
        <Toaster>
          <ConversationContextPanel conversationId={CONV} modelId="vendor/a" />
        </Toaster>
      </AppProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Résumer maintenant" }));
    await screen.findByRole("article", { name: "Résumé proposé" });
    expect(compacts).toEqual(["vendor/a"]);
    expect(screen.getByText("Demandé par vous")).toBeTruthy();
    // A proposal waits: no second summary is offered.
    expect(screen.queryByRole("button", { name: "Résumer maintenant" })).toBeNull();
  });
});

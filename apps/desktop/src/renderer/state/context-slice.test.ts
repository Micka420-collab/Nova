// L2 renderer store: follows main's answers and pushes, turns `unavailable` into "show nothing",
// and rethrows refusals so the UI can say why.
import { describe, expect, it } from "vitest";
import { NovaIpcError, createNovaClient, type CompactionSummary, type ContextEvent, type ContextUsage } from "@nova/shared";
import { createFakeBridge } from "../test/fake-bridge";
import { contextTargetKey, createContextStore, pendingSummary } from "./context-slice";

const CONV = "00000000-0000-4000-8000-00000000e001";
const target = { kind: "conversation" as const, conversationId: CONV };
const usage: ContextUsage = { target, modelId: "vendor/a", usedTokens: 820, contextLength: 1_000, ratio: 0.82, source: "provider_usage", proposalDue: true, measuredAt: 1 };
const proposal: CompactionSummary = {
  id: "00000000-0000-4000-8000-00000000e002", target, kind: "compaction", reason: "manual", status: "proposed", summary: "Résumé.", summarizerModelId: "vendor/a",
  fromModelId: null, toModelId: null, coveredUntilSeq: 2, tokensBefore: 820, tokensAfter: 30, pruned: [], costUsd: 0.001, createdAt: 5, decidedAt: null,
};

describe("context store", () => {
  it("marks the group unavailable when main is not wired, without throwing from load", async () => {
    const store = createContextStore(createNovaClient(createFakeBridge().bridge));
    await store.getState().load(target);
    expect(store.getState().availability).toBe("unavailable");
    await expect(store.getState().compact(target, "vendor/a", null)).rejects.toBeInstanceOf(NovaIpcError);
    expect(store.getState().targets[contextTargetKey(target)]?.busy).toBeNull();
  });

  it("loads usage and summaries, then follows compaction and decisions", async () => {
    let listener: ((event: ContextEvent) => void) | null = null;
    const fake = createFakeBridge({
      harness: {
        context: {
          usage: async () => ({ ok: true, value: usage }),
          list: async () => ({ ok: true, value: [] }),
          compact: async (req) => ({ ok: true, value: { ...proposal, summarizerModelId: req.modelId } }),
          decide: async (req) => ({ ok: true, value: { ...proposal, status: req.decision === "apply" ? "applied" : "dismissed", decidedAt: 9 } }),
          onEvent: (next) => {
            listener = next;
            return () => undefined;
          },
        },
      },
    });
    const store = createContextStore(createNovaClient(fake.bridge));
    await store.getState().load(target);
    const key = contextTargetKey(target);
    expect(store.getState()).toMatchObject({ availability: "available", targets: { [key]: { usage, summaries: [] } } });

    const summary = await store.getState().compact(target, "vendor/a", "garder les tests");
    expect(pendingSummary(store.getState().targets[key] ?? { usage: null, summaries: [], busy: null })?.id).toBe(summary.id);
    await store.getState().decide(summary, "apply");
    expect(store.getState().targets[key]?.summaries.map((item) => item.status)).toEqual(["applied"]);

    // Pushed usage replaces the last one.
    const emit = listener as ((event: ContextEvent) => void) | null;
    emit?.({ type: "context.usage", usage: { ...usage, usedTokens: 100, ratio: 0.1, proposalDue: false } });
    expect(store.getState().targets[key]?.usage?.usedTokens).toBe(100);
  });
});

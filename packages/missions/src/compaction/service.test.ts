// C7/A15 main-side rules: proposals only at the threshold of a KNOWN context length, one pending
// proposal, explicit and idempotent decisions, the applied summary replacing exactly what it
// covers, bounded pruning, and a secret-free handoff that switches the model at the next call.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompactionSummary, ContextEvent, ContextTarget, HandoffDossier, Message, MissionEvent, MissionTask } from "@nova/shared";
import { buildCompactionPrompt, normalizeCompactionSummary } from "../../../agent-runtime/src/compaction-prompt";
import { createHarness } from "../__fixtures__/harness";
import type { MissionEventInput, ProxyMessage } from "../index";
import type { LoopContextHook } from "../loop";
import {
  CompactionError,
  createCompactionCore,
  type CompactionServiceDeps,
  type CompactionStoreLike,
  type NewSummaryInput,
  type SummarizeRequest,
} from "./index";

const MISSION = "22222222-2222-4222-8222-222222222222";
const MODEL = "acme/model";
const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";

function memorySummaries(): CompactionStoreLike & { rows: CompactionSummary[]; seqs: Map<string, { id: string; seq: number }[]> } {
  const rows: CompactionSummary[] = [];
  const dossiers = new Map<string, HandoffDossier>();
  const seqs = new Map<string, { id: string; seq: number }[]>();
  let clock = 1_000;
  const same = (a: ContextTarget, b: ContextTarget): boolean => JSON.stringify(a) === JSON.stringify(b);
  return {
    rows,
    seqs,
    insert(input: NewSummaryInput, dossier) {
      const row: CompactionSummary = { ...input, id: randomUUID(), status: "proposed", createdAt: (clock += 1), decidedAt: null };
      rows.push(row);
      if (dossier) dossiers.set(row.id, { ...dossier, summaryId: row.id, createdAt: row.createdAt });
      return row;
    },
    get: (id) => rows.find((row) => row.id === id) ?? null,
    dossier: (id) => dossiers.get(id) ?? null,
    list: (target) => rows.filter((row) => same(row.target, target)),
    latestApplied: (target) => rows.filter((row) => same(row.target, target) && row.status === "applied").at(-1) ?? null,
    pending: (target) => rows.filter((row) => same(row.target, target) && row.status === "proposed").at(-1) ?? null,
    decide(id, status) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.status !== "proposed") return null;
      row.status = status;
      row.decidedAt = (clock += 1);
      return { ...row };
    },
    conversationMessageSeqs: (conversationId) => seqs.get(conversationId) ?? [],
  };
}

interface Setup {
  contextLength?: number | null;
  missionId?: () => string;
  goal?: string;
  events?: MissionEvent[];
  tasks?: Pick<MissionTask, "title" | "state" | "acceptance">[];
  messages?: Message[];
  summaryText?: string;
}

function setup(options: Setup = {}) {
  const summaries = memorySummaries();
  const journaled: MissionEventInput[] = [];
  const pushed: ContextEvent[] = [];
  const calls: SummarizeRequest[] = [];
  const models = new Map<string, string>();
  let running = true;
  const missionId = options.missionId ?? (() => MISSION);
  const deps: CompactionServiceDeps = {
    summaries,
    missions: {
      get: (id) => (id === missionId() ? { id, goal: options.goal ?? "Corriger le panier", modelId: models.get(id) ?? MODEL, state: "running" } : null),
      setModel: (id, modelId) => models.set(id, modelId),
      events: () => options.events ?? [],
      lastEventSeq: () => 42,
      tasks: () => options.tasks ?? [],
      isRunning: (id) => running && id === missionId(),
    },
    conversations: {
      get: (id) => (id === "conv" ? { id, modelId: MODEL } : null),
      messages: () => options.messages ?? [],
    },
    model: (id) => (id === MODEL || id === "acme/next" ? { contextLength: options.contextLength === undefined ? 1_000 : options.contextLength, supportsTools: true } : null),
    journal: { append: (event) => journaled.push(event) },
    async summarize(request) {
      calls.push(request);
      return { text: options.summaryText ?? `Résumé du travail. Clé : ${SECRET}`, costUsd: 0.002 };
    },
    prompt: buildCompactionPrompt,
    normalize: normalizeCompactionSummary,
    summaryMaxTokens: 2_000,
  };
  const core = createCompactionCore(deps);
  core.onEvent((event) => pushed.push(event));
  return {
    core,
    summaries,
    journaled,
    pushed,
    calls,
    models,
    stop: () => {
      running = false;
    },
  };
}

const usage = (promptTokens: number | null) => ({ promptTokens, completionTokens: 0, reasoningTokens: null, cachedTokens: null, cost: 0.001 });

function transcript(extraTool = "contenu"): ProxyMessage[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "Goal: corriger le panier" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"src/cart.ts"}' }] },
    { role: "tool", toolCallId: "c1", content: extraTool },
  ];
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function proposed(h: ReturnType<typeof setup>, used = 850): Promise<CompactionSummary> {
  await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript() });
  h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(used), messageCount: 5 });
  await settle();
  const summary = h.summaries.rows.at(-1);
  if (!summary) throw new Error("no proposal");
  return summary;
}

describe("context usage and automatic proposals", () => {
  it("proposes once at 80 % of a known context length and journals the proposal", async () => {
    const h = setup();
    await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript() });
    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(790), messageCount: 5 });
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(h.journaled.at(-1)).toMatchObject({ type: "context.usage", usage: { usedTokens: 790, contextLength: 1_000, source: "provider_usage", proposalDue: false } });

    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(800), messageCount: 5 });
    await settle();
    expect(h.calls).toHaveLength(1);
    const summary = h.summaries.rows[0];
    expect(summary).toMatchObject({ status: "proposed", reason: "proposed", coveredUntilSeq: 42, summarizerModelId: MODEL, tokensBefore: 800 });
    // Redacted before storage: the summary never carries a key.
    expect(summary?.summary).not.toContain(SECRET);
    expect(h.journaled.map((event) => event.type)).toContain("compaction.proposed");
    expect(h.pushed.at(-1)).toMatchObject({ type: "compaction.updated", summary: { id: summary?.id, status: "proposed" } });

    // One pending proposal at a time: higher usage proposes nothing more.
    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(950), messageCount: 5 });
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.core.usage({ kind: "mission", missionId: MISSION })).toMatchObject({ proposalDue: false, ratio: 0.95 });
  });

  it("never proposes without the model's context length, however large the usage", async () => {
    const h = setup({ contextLength: null });
    await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript() });
    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(5_000_000), messageCount: 5 });
    await settle();
    expect(h.calls).toHaveLength(0);
    expect(h.core.usage({ kind: "mission", missionId: MISSION })).toMatchObject({ contextLength: null, ratio: null, proposalDue: false });
  });

  it("says the usage is an estimate when the provider reported none, and unknown before any call", async () => {
    const h = setup();
    expect(h.core.usage({ kind: "mission", missionId: MISSION })).toMatchObject({ usedTokens: null, source: "unknown" });
    await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript() });
    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(null), messageCount: 5 });
    expect(h.core.usage({ kind: "mission", missionId: MISSION })).toMatchObject({ source: "estimate" });
  });

  it("waits for more context after a dismissal before proposing again", async () => {
    const h = setup();
    const first = await proposed(h);
    h.core.decide({ summaryId: first.id, decision: "dismiss" });
    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(900), messageCount: 5 });
    await settle();
    expect(h.calls).toHaveLength(1);
    h.core.runtimeHook.observe({ missionId: MISSION, modelId: MODEL, usage: usage(960), messageCount: 5 });
    await settle();
    expect(h.calls).toHaveLength(2);
  });
});

describe("decisions", () => {
  it("is idempotent, refuses a contrary second decision, and journals each outcome", async () => {
    const h = setup();
    const summary = await proposed(h);
    expect(h.core.decide({ summaryId: summary.id, decision: "apply" })).toMatchObject({ status: "applied" });
    expect(h.core.decide({ summaryId: summary.id, decision: "apply" })).toMatchObject({ status: "applied" });
    expect(() => h.core.decide({ summaryId: summary.id, decision: "dismiss" })).toThrow(CompactionError);
    expect(() => h.core.decide({ summaryId: randomUUID(), decision: "apply" })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(h.journaled.filter((event) => event.type === "compaction.applied")).toHaveLength(1);
  });

  it("replaces exactly the covered transcript at the next call, keeping system, goal and what came after", async () => {
    const h = setup();
    const summary = await proposed(h);
    h.core.decide({ summaryId: summary.id, decision: "apply" });
    const later: ProxyMessage[] = [
      ...transcript(),
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "run_tests", arguments: "{}" }] },
      { role: "tool", toolCallId: "c2", content: "2 passed" },
    ];
    const prepared = await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: later });
    expect(prepared?.modelId).toBeNull();
    const messages = prepared?.messages ?? [];
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
    expect(messages[2]?.content).toContain("approved by the user");
    expect(messages[2]?.content).toContain(summary.summary);
    expect(messages.slice(3)).toEqual(later.slice(4));
    // Applied once: the following call is unchanged.
    expect(await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages })).toBeNull();
  });

  it("refuses to apply a summary while a model switch waits (its dossier was written without it)", async () => {
    const h = setup();
    const summary = await proposed(h);
    h.core.handoff({ missionId: MISSION, toModelId: "acme/next" });
    expect(() => h.core.decide({ summaryId: summary.id, decision: "apply" })).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("refuses to apply a mission summary once the mission stopped", async () => {
    const h = setup();
    const summary = await proposed(h);
    h.stop();
    expect(() => h.core.decide({ summaryId: summary.id, decision: "apply" })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(h.core.decide({ summaryId: summary.id, decision: "dismiss" })).toMatchObject({ status: "dismissed" });
  });
});

describe("pruning", () => {
  it("prunes big tool results to head + tail for the summarizer and lists each one", async () => {
    const h = setup();
    const big = `${"a".repeat(10_000)}MIDDLE${"z".repeat(10_000)}`;
    await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript(big) });
    const summary = await h.core.compact({ target: { kind: "mission", missionId: MISSION }, modelId: MODEL, instructions: "les tests" });
    expect(summary.reason).toBe("manual");
    expect(summary.pruned).toEqual([{ toolCallId: "c1", tool: "read_file", originalChars: big.length, keptChars: 3_000, artifactId: null }]);
    const quoted = h.calls[0]?.messages.at(-1)?.content ?? "";
    expect(quoted).not.toContain("MIDDLE");
    expect(quoted).toContain("characters pruned");
    expect(quoted).toContain("les tests");
    expect(quoted.length).toBeLessThan(big.length);
  });
});

describe("conversations", () => {
  const message = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({
    id, conversationId: "conv", role, content, status: "complete", modelId: MODEL, servedModel: null, servedProvider: null, error: null, usage: null, createdAt: 1, updatedAt: 1, ...extra,
  });

  it("summarizes on request, then sends the summary plus only the messages after it once applied", async () => {
    const messages = [message("m1", "user", "Corrige le panier"), message("m2", "assistant", "C'est fait."), message("m3", "user", "Et la facture ?")];
    const h = setup({ messages: messages.slice(0, 2) });
    h.summaries.seqs.set("conv", [{ id: "m1", seq: 1 }, { id: "m2", seq: 2 }, { id: "m3", seq: 3 }]);
    const target = { kind: "conversation" as const, conversationId: "conv" };
    const summary = await h.core.compact({ target, modelId: MODEL, instructions: null });
    expect(summary).toMatchObject({ status: "proposed", coveredUntilSeq: 2 });
    // Proposed is not applied: the full history is still sent.
    expect(h.core.historyForModel("conv", messages)).toBeNull();
    await expect(h.core.compact({ target, modelId: MODEL, instructions: null })).rejects.toMatchObject({ code: "conflict" });
    h.core.decide({ summaryId: summary.id, decision: "apply" });
    expect(h.core.historyForModel("conv", messages)).toEqual({ summary: summary.summary, history: [messages[2]] });
    expect(h.core.usage(target)).toMatchObject({ source: "estimate", modelId: MODEL });
  });

  it("uses the provider's last report as usage and flags a due proposal without writing one", () => {
    const messages = [message("m1", "user", "Q"), message("m2", "assistant", "R", { usage: usage(820) })];
    const h = setup({ messages });
    const usageNow = h.core.observeConversation("conv");
    expect(usageNow).toMatchObject({ usedTokens: 820, source: "provider_usage", proposalDue: true });
    expect(h.calls).toHaveLength(0);
    expect(h.pushed.at(-1)).toMatchObject({ type: "context.usage" });
  });

  it("refuses to summarize while an answer is being written", async () => {
    const h = setup({ messages: [message("m1", "user", "Q"), message("m2", "assistant", "", { status: "streaming" })] });
    await expect(h.core.compact({ target: { kind: "conversation", conversationId: "conv" }, modelId: MODEL, instructions: null })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("handoff (A15)", () => {
  const events = (): MissionEvent[] => [
    {
      id: randomUUID(), missionId: MISSION, seq: 1, at: 1, type: "tool.requested", taskId: null,
      call: { id: "w1", name: "write_file", operation: "write", argumentsPreview: "", path: "src/cart.ts", host: null, argv: null },
    },
    { id: randomUUID(), missionId: MISSION, seq: 2, at: 2, type: "tool.finished", callId: "w1", state: "succeeded", durationMs: 1, display: { kind: "text", text: "" } } as unknown as MissionEvent,
  ];

  it("builds a bounded, secret-free dossier from the journal and switches model at the next call", async () => {
    const h = setup({
      goal: `Corriger le panier avec la clé ${SECRET}`,
      events: events(),
      tasks: [
        { title: "Lire le code", state: "verified", acceptance: { kind: "manual", detail: "" } },
        { title: "Tests verts", state: "todo", acceptance: { kind: "test_passes", detail: "cart" } },
      ],
    });
    await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript(`sortie ${SECRET}`) });
    const dossier = h.core.handoff({ missionId: MISSION, toModelId: "acme/next" });
    expect(dossier).toMatchObject({ fromModelId: MODEL, toModelId: "acme/next", done: ["Lire le code"], filesTouched: ["src/cart.ts"] });
    expect(dossier.remaining).toEqual(["Tests verts (critère : un test passe — cart)"]);
    expect(JSON.stringify(dossier)).not.toContain(SECRET);
    const stored = h.summaries.rows.at(-1);
    expect(stored).toMatchObject({ kind: "handoff", reason: "model_switch", status: "applied", toModelId: "acme/next" });
    expect(stored?.summary).not.toContain(SECRET);
    expect(h.journaled.map((event) => event.type)).toEqual(["handoff.created"]);
    expect(() => h.core.handoff({ missionId: MISSION, toModelId: "acme/next" })).toThrow(expect.objectContaining({ code: "conflict" }));

    const prepared = await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript() });
    expect(prepared?.modelId).toBe("acme/next");
    expect(prepared?.messages?.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(prepared?.messages?.[2]?.content).toContain("Handoff dossier");
    expect(h.models.get(MISSION)).toBe("acme/next");
    expect(h.journaled.at(-1)).toMatchObject({ type: "model.switched", fromModelId: MODEL, toModelId: "acme/next", handoffSummaryId: stored?.id });
  });

  it("refuses an unknown model, the same model, and a mission that is not running", async () => {
    const h = setup();
    await h.core.runtimeHook.prepare({ missionId: MISSION, modelId: MODEL, messages: transcript() });
    expect(() => h.core.handoff({ missionId: MISSION, toModelId: "acme/unknown" })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => h.core.handoff({ missionId: MISSION, toModelId: MODEL })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    h.stop();
    expect(() => h.core.handoff({ missionId: MISSION, toModelId: "acme/next" })).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

describe("with the real mission loop", () => {
  it("proposes past 80 %, and once applied the next model request carries the summary", async () => {
    let missionId = "";
    const h = setup({ contextLength: 140, missionId: () => missionId, summaryText: "Le fichier src/cart.ts a été lu." });
    // The loop waits for the proposal to be applied before its next call (as a user would).
    let gate: Promise<void> = Promise.resolve();
    const opener: { open: () => void } = { open: () => undefined };
    h.core.onEvent((event) => {
      if (event.type === "compaction.updated" && event.summary.status === "proposed") {
        h.core.decide({ summaryId: event.summary.id, decision: "apply" });
        opener.open();
      }
    });
    const hook: LoopContextHook = {
      prepare: async (input) => {
        await gate;
        return h.core.runtimeHook.prepare(input);
      },
      observe: (input) => {
        if (h.calls.length === 0 && input.messageCount > 3) gate = new Promise((resolve) => (opener.open = resolve));
        h.core.runtimeHook.observe(input);
      },
    };
    const read = { name: "read_file", arguments: '{"path":"src/cart.ts"}' };
    const harness = createHarness({
      files: { "src/cart.ts": "export const total = 1;\n" },
      tasks: [{ title: "Lire", acceptance: { kind: "manual", detail: "" } }],
      extensions: { context: hook },
      turns: [{ calls: [read] }, { calls: [read] }, { text: "Lu." }],
    });
    missionId = harness.missionId;
    await harness.start();
    // Usage 120 of 140 (≥ 80 %): the second observation proposes, the user applies. (The fake
    // provider keeps reporting 120 tokens, so the last call proposes again: nothing is silent.)
    expect(h.summaries.rows[0]).toMatchObject({ status: "applied", reason: "proposed" });
    const third = harness.requests[2]?.messages ?? [];
    expect(third.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
    expect(third[2]?.content).toContain("Le fichier src/cart.ts a été lu.");
    expect(harness.terminals()[0]).toMatchObject({ type: "mission.succeeded" });
  });
});

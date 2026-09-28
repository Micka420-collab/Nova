// `context.*` in main, without Electron: real SQLite repos and mission journal, the real
// ChatRunner for the conversation path, a scripted provider/proxy. Checks what the user sees
// (typed refusals, events) and what the model receives (only what the user applied).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRunner } from "@nova/agent-runtime";
import { ProxyError, createMissionJournal, type MissionEventInput, type ProviderProxy, type ProxyMessage, type ProxyStreamRequest } from "@nova/missions";
import type { ModelProvider, ProviderStreamEvent, StreamChatRequest } from "@nova/providers";
import { DEFAULT_SETTINGS, type ContextEvent, type MissionEvent, type ModelInfo } from "@nova/shared";
import { createCompactionRepo, createMissionRepo, createWorkspaceRepo, openNovaStore, type MissionRepo, type NovaStore } from "@nova/storage";
// Until @nova/agent-runtime exports it (J2-B L2 contract request), the prompt module is read from source.
import { COMPACTION_SUMMARY_MAX_TOKENS, buildCompactionPrompt, normalizeCompactionSummary } from "../../../../../packages/agent-runtime/src/compaction-prompt";
import { ServiceError } from "../service-error";
import { createContextService, type ContextService } from "./context-service";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const MODEL = "acme/tools";
const NEXT = "acme/next";

function info(id: string, contextLength: number | null): ModelInfo {
  return {
    id, name: id, author: "acme", description: null, contextLength, maxCompletionTokens: null, inputModalities: ["text"], outputModalities: ["text"],
    supportsTools: true, supportsStructuredOutputs: null, supportsReasoning: null, pricing: { promptPerMTok: 1, completionPerMTok: 2, variable: false },
    isFree: false, expirationDate: null, createdAt: null,
  };
}

let store: NovaStore;
let missions: MissionRepo;
let service: ContextService;
let pushed: ContextEvent[];
let journaled: MissionEvent[];
let proxyRequests: ProxyStreamRequest[];
let proxyFailure: Error | null;
let chatRequests: StreamChatRequest[];
let key: string | null;
let running: Set<string>;

async function* answer(text: string, promptTokens = 50): AsyncGenerator<ProviderStreamEvent> {
  yield { type: "reasoning" };
  yield { type: "text", text };
  yield { type: "usage", usage: { promptTokens, completionTokens: 5, reasoningTokens: 3, cachedTokens: null, cost: 0.001 } };
  yield { type: "finish", finishReason: "stop" };
}

const provider: ModelProvider = {
  id: "openrouter",
  listModels: async () => [],
  checkKey: async () => {
    throw new Error("unused");
  },
  streamChat(_key, request) {
    chatRequests.push(request);
    const summarizing = request.messages[0]?.content.startsWith("You write the working summary") ?? false;
    return answer(summarizing ? "Le panier a été corrigé." : "Réponse.", summarizing ? 10 : 900);
  },
};

const proxy: ProviderProxy = {
  stream(request) {
    proxyRequests.push(request);
    const failure = proxyFailure;
    return (async function* () {
      if (failure) throw failure;
      yield { type: "reasoning" as const };
      yield { type: "text" as const, text: `Travail résumé. ${KEY}` };
      yield { type: "usage" as const, usage: { promptTokens: 400, completionTokens: 40, reasoningTokens: null, cachedTokens: null, cost: 0.003 } };
    })();
  },
};

beforeEach(() => {
  store = openNovaStore(":memory:");
  store.saveCatalog("openrouter", [info(MODEL, 1_000), info(NEXT, 2_000)], 1);
  missions = createMissionRepo(store.db);
  pushed = [];
  journaled = [];
  proxyRequests = [];
  proxyFailure = null;
  chatRequests = [];
  key = KEY;
  running = new Set();
  const journal = createMissionJournal({
    store: { appendEvent: missions.appendEvent, listEvents: missions.listEvents, setState: missions.setState },
    push: (event) => journaled.push(event),
  });
  service = createContextService({
    store,
    provider,
    resolveApiKey: async () => key,
    missions: () => ({ isRunning: (id) => running.has(id), journal: { append: (event: MissionEventInput) => journal.append(event) }, proxy }),
    push: (event) => pushed.push(event),
    prompt: buildCompactionPrompt,
    normalize: normalizeCompactionSummary,
    summaryMaxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
  });
});
afterEach(() => {
  service.dispose();
  store.close();
});

function newMission(): string {
  const workspaceId = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: "/shop", name: "shop" }).id;
  const id = missions.create({
    workspaceId, conversationId: null, title: "Panier", goal: "Corriger le panier", mode: "fix", modelId: MODEL,
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: 60_000, budgetUsd: 0.5 },
  }).id;
  running.add(id);
  return id;
}

const transcript: ProxyMessage[] = [
  { role: "system", content: "system" },
  { role: "user", content: "Goal: corriger le panier" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"src/cart.ts"}' }] },
  { role: "tool", toolCallId: "c1", content: "export const total = 1;" },
];

const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 0, reasoningTokens: null, cachedTokens: null, cost: 0.001 });

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("missions", () => {
  it("proposes at 80 % through the budgeted proxy, journals it, and applies it only after the user decides", async () => {
    const missionId = newMission();
    await service.runtimeHook.prepare({ missionId, modelId: MODEL, messages: transcript });
    service.runtimeHook.observe({ missionId, modelId: MODEL, usage: usage(850), messageCount: 5 });
    await settle();
    // One summarizing call, charged to the mission (proxy = reservation on its budget), no tools.
    expect(proxyRequests).toMatchObject([{ missionId, modelId: MODEL, tools: [], webSearch: false, maxTokens: COMPACTION_SUMMARY_MAX_TOKENS }]);
    const [proposal] = await service.api.list({ target: { kind: "mission", missionId } });
    expect(proposal).toMatchObject({ status: "proposed", reason: "proposed", costUsd: 0.003 });
    expect(proposal?.summary).not.toContain(KEY);
    // Nothing applied yet: the next call is unchanged.
    expect(await service.runtimeHook.prepare({ missionId, modelId: MODEL, messages: transcript })).toBeNull();

    await service.api.decide({ summaryId: proposal?.id ?? "", decision: "apply" });
    const prepared = await service.runtimeHook.prepare({ missionId, modelId: MODEL, messages: transcript });
    expect(prepared?.messages?.[2]?.content).toContain("Travail résumé.");

    // Live usage is pushed but never stored; the proposal and the decision are stored.
    const storedTypes = missions.listEvents(missionId).map((event) => event.type);
    expect(storedTypes).toEqual(["compaction.proposed", "compaction.applied"]);
    expect(journaled.some((event) => event.type === "context.usage" && event.seq === 0)).toBe(true);
    expect(pushed.map((event) => event.type)).toEqual(["context.usage", "compaction.updated", "compaction.updated"]);
  });

  it("turns a budget refusal of the summarizing call into a visible conflict, with nothing stored", async () => {
    const missionId = newMission();
    await service.runtimeHook.prepare({ missionId, modelId: MODEL, messages: transcript });
    proxyFailure = new ProxyError("budget", "budget de la mission atteint");
    const refusal = service.api.compact({ target: { kind: "mission", missionId }, modelId: MODEL, instructions: null });
    await expect(refusal).rejects.toBeInstanceOf(ServiceError);
    await expect(refusal).rejects.toMatchObject({ code: "conflict" });
    expect(await service.api.list({ target: { kind: "mission", missionId } })).toEqual([]);
  });

  it("switches model after a handoff: dossier stored and journaled, model persisted, next call on it", async () => {
    const missionId = newMission();
    await service.runtimeHook.prepare({ missionId, modelId: MODEL, messages: transcript });
    const dossier = await service.api.handoff({ missionId, toModelId: NEXT });
    expect(dossier).toMatchObject({ missionId, fromModelId: MODEL, toModelId: NEXT, goal: "Corriger le panier" });
    expect(createCompactionRepo(store.db).dossier(dossier.summaryId)).toEqual(dossier);
    const prepared = await service.runtimeHook.prepare({ missionId, modelId: MODEL, messages: transcript });
    expect(prepared?.modelId).toBe(NEXT);
    expect(missions.get(missionId)?.modelId).toBe(NEXT);
    expect(missions.listEvents(missionId).map((event) => event.type)).toEqual(["handoff.created", "model.switched"]);
    await expect(service.api.handoff({ missionId, toModelId: "acme/absent" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports unknown usage for a mission that is not running, with the catalog's context length", async () => {
    const missionId = newMission();
    running.delete(missionId);
    expect(await service.api.usage({ target: { kind: "mission", missionId } })).toMatchObject({
      modelId: MODEL, usedTokens: null, contextLength: 1_000, ratio: null, source: "unknown", proposalDue: false,
    });
    await expect(service.api.compact({ target: { kind: "mission", missionId }, modelId: MODEL, instructions: null })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("conversations (with the real ChatRunner)", () => {
  function runner(): ChatRunner {
    return new ChatRunner({
      store,
      provider,
      resolveApiKey: async () => key,
      getSettings: () => DEFAULT_SETTINGS,
      emit: () => undefined,
      historyForModel: (conversationId, history) => service.historyForModel(conversationId, history),
    });
  }

  it("/compact writes a proposal; once applied the next request is summary + the new message only", async () => {
    const chat = runner();
    const first = await chat.send({ conversationId: null, content: "Corrige le panier", modelId: MODEL });
    await chat.idle();
    const conversationId = first.conversation.id;
    expect(service.observeConversation(conversationId)).toMatchObject({ usedTokens: 905, source: "provider_usage", proposalDue: true });

    const target = { kind: "conversation" as const, conversationId };
    const summary = await service.api.compact({ target, modelId: MODEL, instructions: null });
    expect(summary).toMatchObject({ status: "proposed", summary: "Le panier a été corrigé.", costUsd: 0.001 });
    await service.api.decide({ summaryId: summary.id, decision: "apply" });

    await chat.send({ conversationId, content: "Et la facture ?", modelId: MODEL });
    await chat.idle();
    const last = chatRequests.at(-1);
    expect(last?.messages.slice(1)).toEqual([
      { role: "system", content: "Summary of the earlier conversation (approved by the user):\nLe panier a été corrigé." },
      { role: "user", content: "Et la facture ?" },
    ]);
    // The stored conversation is never rewritten.
    expect(store.listMessages(conversationId)).toHaveLength(4);
  });

  it("refuses without a key, and for an unknown conversation or summary", async () => {
    const chat = runner();
    const first = await chat.send({ conversationId: null, content: "Bonjour", modelId: MODEL });
    await chat.idle();
    key = null;
    const target = { kind: "conversation" as const, conversationId: first.conversation.id };
    await expect(service.api.compact({ target, modelId: MODEL, instructions: null })).rejects.toMatchObject({ code: "no_key" });
    await expect(service.api.usage({ target: { kind: "conversation", conversationId: "00000000-0000-4000-8000-000000000000" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.api.decide({ summaryId: "00000000-0000-4000-8000-000000000000", decision: "apply" })).rejects.toMatchObject({ code: "not_found" });
  });
});

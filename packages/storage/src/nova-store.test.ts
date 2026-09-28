import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  type MessageRole,
  type MessageStatus,
  type ModelInfo,
  type UsageSummary,
} from "@nova/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "./nova-store";
import type { NovaStore, ProviderConnectionRecord } from "./types";

let clock: number;
let store: NovaStore;
beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:", { now: () => clock });
});
afterEach(() => {
  store.close();
});

const usage = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  promptTokens: 10,
  completionTokens: 5,
  reasoningTokens: null,
  cachedTokens: null,
  cost: 0.002,
  ...overrides,
});

function add(conversationId: string, role: MessageRole, content: string, status: MessageStatus = "complete") {
  return store.insertMessage({ conversationId, role, content, status, modelId: null });
}

function conversationWithMessages(title: string, contents: string[]): string {
  const { id } = store.createConversation({ title, modelId: null });
  contents.forEach((content, index) => add(id, index % 2 === 0 ? "user" : "assistant", content));
  return id;
}

describe("settings", () => {
  it("returns defaults and deep-merges successive patches", () => {
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    store.updateSettings({ companion: { visible: false } });
    store.updateSettings({ theme: "dark", defaultModelId: "deepseek/deepseek-chat" });
    store.updateSettings({ display: { density: "all" }, onboarding: { profile: "code" } });
    const updated = store.updateSettings({ privacy: { providerDataCollection: "allow" }, chat: { autopilot: true } });
    expect(updated).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      defaultModelId: "deepseek/deepseek-chat",
      companion: { visible: false, motion: "system" },
      privacy: { providerDataCollection: "allow" },
      // J2-B groups deep-merge like the others: a patch keeps the group's other fields.
      onboarding: { profile: "code", completedAt: null },
      display: { density: "all" },
      chat: { autopilot: true, suggestVisionModel: true },
    });
    expect(store.getSettings()).toEqual(updated);
    expect(store.updateSettings({ defaultModelId: null }).defaultModelId).toBeNull();
  });

  it("fills missing fields of a stored group with defaults and ignores invalid rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-settings-"));
    try {
      const file = join(dir, "nova.db");
      openNovaStore(file).close();
      const raw = new DatabaseSync(file);
      const insert = raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      insert.run("companion", JSON.stringify({ visible: false }));
      insert.run("theme", JSON.stringify("blue"));
      insert.run("legacy", JSON.stringify(1));
      insert.run("privacy", "{not json");
      raw.close();

      const fileStore = openNovaStore(file);
      expect(fileStore.getSettings()).toEqual({
        ...DEFAULT_SETTINGS,
        companion: { visible: false, motion: "system" },
      });
      fileStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secrets and connections", () => {
  const connection = (secretRef: string | null): ProviderConnectionRecord => ({
    providerId: "openrouter",
    secretRef,
    storage: "vault",
    keyHint: "a1b2",
    state: "invalid",
    lastCheckedAt: 1_500,
    lastError: {
      code: "invalid_key",
      httpStatus: 401,
      retryAfterSec: null,
      providerMessage: "No auth credentials found",
      retryable: false,
    },
    check: { label: null, limit: null, limitRemaining: null, usage: 0.5, isFreeTier: false },
    updatedAt: 1_600,
  });

  it("stores ciphertext as a BLOB and reads it back byte for byte", () => {
    const ciphertext = new Uint8Array([0, 255, 1, 128, 0, 42]);
    store.putSecret({ id: "s1", ciphertext, backend: "gnome_libsecret", createdAt: 5 });
    const secret = store.getSecret("s1");
    expect(secret?.ciphertext).toBeInstanceOf(Uint8Array);
    expect(Array.from(secret?.ciphertext ?? [])).toEqual([0, 255, 1, 128, 0, 42]);
    expect(secret).toMatchObject({ id: "s1", backend: "gnome_libsecret", createdAt: 5 });
    expect(store.getSecret("missing")).toBeNull();
  });

  it("round-trips a connection and keeps its secret reference across secret upserts", () => {
    store.putSecret({ id: "s1", ciphertext: new Uint8Array([1]), backend: "dpapi", createdAt: 1 });
    store.upsertConnection(connection("s1"));
    expect(store.getConnection("openrouter")).toEqual(connection("s1"));

    store.putSecret({ id: "s1", ciphertext: new Uint8Array([2]), backend: "dpapi", createdAt: 2 });
    expect(store.getConnection("openrouter")?.secretRef).toBe("s1");
    expect(Array.from(store.getSecret("s1")?.ciphertext ?? [])).toEqual([2]);

    store.deleteSecret("s1");
    expect(store.getConnection("openrouter")?.secretRef).toBeNull();

    store.upsertConnection({ ...connection(null), state: "valid", lastError: null, check: null });
    expect(store.getConnection("openrouter")).toMatchObject({ state: "valid", lastError: null, check: null });
    store.deleteConnection("openrouter");
    expect(store.getConnection("openrouter")).toBeNull();
  });
});

describe("model catalog", () => {
  it("round-trips models including unknown (null) fields", () => {
    expect(store.loadCatalog("openrouter")).toBeNull();
    const models: ModelInfo[] = [
      {
        id: "author/model",
        name: "Model",
        author: "author",
        description: null,
        contextLength: 128_000,
        maxCompletionTokens: null,
        inputModalities: ["text"],
        outputModalities: null,
        supportsTools: null,
        supportsStructuredOutputs: false,
        supportsReasoning: true,
        pricing: { promptPerMTok: 0.3, completionPerMTok: null, variable: false },
        isFree: false,
        expirationDate: null,
        createdAt: null,
      },
    ];
    store.saveCatalog("openrouter", models, 42);
    expect(store.loadCatalog("openrouter")).toEqual({ models, fetchedAt: 42 });
    store.saveCatalog("openrouter", [], 43);
    expect(store.loadCatalog("openrouter")).toEqual({ models: [], fetchedAt: 43 });
  });
});

describe("conversations and messages", () => {
  it("creates, renames, touches and deletes conversations", () => {
    const created = store.createConversation({ title: "Premier", modelId: null });
    expect(created).toMatchObject({ title: "Premier", modelId: null, createdAt: 1_000, updatedAt: 1_000 });
    clock = 2_000;
    expect(store.renameConversation(created.id, "Renommé")).toEqual({ ...created, title: "Renommé" });
    store.touchConversation(created.id, "author/model");
    expect(store.getConversation(created.id)).toMatchObject({ modelId: "author/model", updatedAt: 2_000 });
    expect(store.renameConversation("missing", "x")).toBeNull();
    expect(store.deleteConversation(created.id)).toBe(true);
    expect(store.deleteConversation(created.id)).toBe(false);
    expect(store.getConversation(created.id)).toBeNull();
  });

  it("keeps messages in insertion order and applies partial patches", () => {
    const { id } = store.createConversation({ title: "t", modelId: null });
    const user = add(id, "user", "Q");
    const answer = store.insertMessage({
      conversationId: id,
      role: "assistant",
      content: "",
      status: "streaming",
      modelId: "author/model",
    });
    expect(answer).toMatchObject({ servedModel: null, servedProvider: null, error: null, usage: null });

    clock = 3_000;
    const patched = store.updateMessage(answer.id, { content: "R", servedModel: "author/model-v2" });
    expect(patched).toMatchObject({
      content: "R",
      status: "streaming",
      servedModel: "author/model-v2",
      updatedAt: 3_000,
    });
    const final = store.updateMessage(answer.id, { status: "complete", usage: usage() });
    expect(final).toMatchObject({ content: "R", status: "complete", usage: usage() });
    expect(final?.servedModel).toBe("author/model-v2");
    expect(store.listMessages(id).map((m) => m.id)).toEqual([user.id, answer.id]);

    expect(store.deleteMessage(user.id)).toBe(true);
    expect(store.deleteMessage(user.id)).toBe(false);
    const next = add(id, "user", "Q2");
    expect(store.listMessages(id).map((m) => m.id)).toEqual([answer.id, next.id]);
    expect(store.updateMessage("missing", { content: "x" })).toBeNull();
  });

  it("rejects invalid enum values and unknown conversations", () => {
    const { id } = store.createConversation({ title: "t", modelId: null });
    expect(() => add("missing", "user", "x")).toThrow(/FOREIGN KEY/);
    expect(() =>
      // @ts-expect-error invalid status on purpose
      store.insertMessage({ conversationId: id, role: "user", content: "x", status: "done", modelId: null }),
    ).toThrow(/CHECK/);
  });

  it("cascades a conversation delete to its messages and usage records", () => {
    const id = conversationWithMessages("t", ["Q", "R"]);
    const [, answer] = store.listMessages(id);
    store.recordUsage({
      conversationId: id,
      messageId: answer?.id ?? "",
      providerId: "openrouter",
      modelId: "author/model",
      servedModel: null,
      servedProvider: null,
      usage: usage(),
    });
    expect(store.deleteConversation(id)).toBe(true);
    expect(store.listMessages(id)).toEqual([]);
    expect(store.getMessage(answer?.id ?? "")).toBeNull();
    expect(store.conversationUsage(id)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      messagesWithUnknownCost: 0,
    });
  });
});

describe("listConversations", () => {
  it("orders by last activity with message counts and collapsed previews", () => {
    const older = conversationWithMessages("Ancienne", ["Bonjour", "  Salut\n\n  toi  "]);
    clock = 2_000;
    const newer = conversationWithMessages("Récente", ["x".repeat(130)]);
    clock = 3_000;
    const empty = store.createConversation({ title: "Vide", modelId: null }).id;

    const { items: list, hasMore } = store.listConversations();
    expect(hasMore).toBe(false);
    expect(list.map((c) => c.id)).toEqual([empty, newer, older]);
    expect(list.map((c) => c.messageCount)).toEqual([0, 1, 2]);
    expect(list[0]?.preview).toBeNull();
    expect(list[1]?.preview).toBe(`${"x".repeat(120)}…`);
    expect(list[2]?.preview).toBe("Salut toi");

    clock = 4_000;
    store.touchConversation(older, null);
    expect(store.listConversations({ limit: 2 })).toMatchObject({
      items: [{ id: older }, { id: empty }],
      hasMore: true,
    });
    expect(store.listConversations({ limit: 3 }).hasMore).toBe(false);
  });

  it("reports older conversations beyond the default page instead of hiding them silently", () => {
    for (let index = 0; index < 201; index += 1) {
      clock += 1;
      store.createConversation({ title: `c${index}`, modelId: null });
    }
    const page = store.listConversations();
    expect(page.items).toHaveLength(200);
    expect(page.items.at(-1)?.title).toBe("c1");
    expect(page.hasMore).toBe(true);
    // Search still reaches the conversation left out of the page.
    expect(store.listConversations({ query: "c0" }).items.map((c) => c.title)).toEqual(["c0"]);
  });

  it("previews the last non-empty message while an answer is still streaming", () => {
    const id = conversationWithMessages("t", ["Question posée"]);
    add(id, "assistant", "", "streaming");
    expect(store.listConversations().items[0]).toMatchObject({ messageCount: 2, preview: "Question posée" });
  });

  it("matches titles and contents literally and case-insensitively", () => {
    const byTitle = conversationWithMessages("Été à Paris", ["rien"]);
    const byContent = conversationWithMessages("Sans titre", ["Le taux est de 50% ce MOIS"]);
    const underscore = conversationWithMessages("snake_case", ["x"]);
    conversationWithMessages("Autre", ["50 pourcent, sans underscore"]);

    const ids = (query: string) =>
      store
        .listConversations({ query })
        .items.map((c) => c.id)
        .sort();
    expect(ids("ÉTÉ")).toEqual([byTitle]);
    expect(ids("mois")).toEqual([byContent]);
    expect(ids("%")).toEqual([byContent]);
    expect(ids("50%")).toEqual([byContent]);
    expect(ids("_")).toEqual([underscore]);
    expect(ids("   ")).toHaveLength(4);
    expect(ids("introuvable")).toEqual([]);
  });

  it("matches text whatever its Unicode normalization form", () => {
    const decomposedTitle = conversationWithMessages("Cafe\u0301 du matin".normalize("NFD"), ["x"]);
    const decomposedContent = conversationWithMessages("Sans titre", ["Un GRAND ÉLAN".normalize("NFD")]);
    const ids = (query: string) =>
      store
        .listConversations({ query })
        .items.map((c) => c.id)
        .sort();
    expect(ids("café")).toEqual([decomposedTitle]);
    expect(ids("Cafe\u0301".normalize("NFD"))).toEqual([decomposedTitle]);
    expect(ids("élan")).toEqual([decomposedContent]);
    // NFKC also folds compatibility forms (full-width letters, ligatures).
    expect(ids("ＣＡＦÉ")).toEqual([decomposedTitle]);
  });
});

describe("usage", () => {
  it("sums reported usage and counts possibly billed answers whose cost is unknown", () => {
    const id = conversationWithMessages("t", ["Q1", "R1", "Q2", "R2", "Q3", "R3"]);
    const [, r1, , r2, , r3] = store.listMessages(id);
    const record = (messageId: string, summary: UsageSummary) =>
      store.recordUsage({
        conversationId: id,
        messageId,
        providerId: "openrouter",
        modelId: "author/model",
        servedModel: "author/model",
        servedProvider: "Upstream",
        usage: summary,
      });
    record(r1?.id ?? "", usage({ promptTokens: 100, completionTokens: 20, cost: 0.25 }));
    // Usage reported without a cost: still unknown cost.
    record(r2?.id ?? "", usage({ promptTokens: 50, completionTokens: null, cost: null }));
    // r3 has no usage at all. Stopped, interrupted and partially streamed answers may be billed:
    // unknown. A failure before any text (HTTP 402/429) is not billed and not counted.
    add(id, "assistant", "…", "stopped");
    add(id, "assistant", "début", "interrupted");
    add(id, "assistant", "début", "error");
    add(id, "assistant", "", "error");

    expect(store.conversationUsage(id)).toEqual({
      promptTokens: 150,
      completionTokens: 20,
      cost: 0.25,
      messagesWithUnknownCost: 5,
    });

    // Deleting a billed message (retry) keeps its usage in the totals, and a null-cost record
    // keeps counting as unknown once its message is gone.
    expect(r3).toBeDefined();
    expect(store.deleteMessage(r1?.id ?? "")).toBe(true);
    expect(store.deleteMessage(r2?.id ?? "")).toBe(true);
    expect(store.conversationUsage(id)).toMatchObject({
      promptTokens: 150,
      cost: 0.25,
      messagesWithUnknownCost: 5,
    });
  });

  it("counts each unknown-cost generation once, before and after a retry supersedes it", () => {
    const id = conversationWithMessages("t", ["Q"]);
    const unknown = () => store.conversationUsage(id).messagesWithUnknownCost;
    const fallback = { providerId: "openrouter" as const, modelId: "author/model" };
    // Interrupted by a crash: no usage record, counted from its status, then kept by supersede.
    const interrupted = add(id, "assistant", "par", "interrupted");
    expect(unknown()).toBe(1);
    expect(store.supersedeMessage(interrupted.id, fallback)).toBe(true);
    expect(store.getMessage(interrupted.id)).toBeNull();
    expect(unknown()).toBe(1);

    // Already recorded with a null cost: supersede adds nothing, the record keeps counting.
    const stopped = add(id, "assistant", "", "stopped");
    store.recordUsage({
      conversationId: id,
      messageId: stopped.id,
      providerId: "openrouter",
      modelId: "author/model",
      servedModel: null,
      servedProvider: null,
      usage: usage({ promptTokens: null, completionTokens: null, cost: null }),
    });
    expect(unknown()).toBe(2);
    store.supersedeMessage(stopped.id, fallback);
    expect(unknown()).toBe(2);

    // A failure before any answer was not billed: superseding it records nothing.
    const refused = add(id, "assistant", "", "error");
    store.supersedeMessage(refused.id, fallback);
    expect(unknown()).toBe(2);
    expect(store.supersedeMessage(refused.id, fallback)).toBe(false);
  });
});

describe("erasure on disk", () => {
  it("leaves no bytes of a deleted secret or conversation in the database files", () => {
    const dir = mkdtempSync(join(tmpdir(), "nova-erase-"));
    const onDisk = openNovaStore(join(dir, "nova.sqlite"));
    const diskContains = (marker: string) =>
      readdirSync(dir).some((name) => readFileSync(join(dir, name)).includes(marker));
    try {
      const secretMarker = "SECRETMARKER-4f1c9a";
      const titleMarker = "TITLEMARKER-7d2e0b";
      const messageMarker = "MESSAGEMARKER-93ab11";
      onDisk.putSecret({
        id: "s1",
        ciphertext: new TextEncoder().encode(`v10${secretMarker}`),
        backend: "basic_text",
        createdAt: 1,
      });
      const conversation = onDisk.createConversation({ title: titleMarker, modelId: null });
      onDisk.insertMessage({
        conversationId: conversation.id,
        role: "user",
        content: messageMarker.repeat(50),
        status: "complete",
        modelId: null,
      });
      expect(diskContains(secretMarker)).toBe(true);

      onDisk.deleteSecret("s1");
      onDisk.deleteConversation(conversation.id);
      for (const marker of [secretMarker, titleMarker, messageMarker]) expect(diskContains(marker)).toBe(false);
      onDisk.close();
      for (const marker of [secretMarker, titleMarker, messageMarker]) expect(diskContains(marker)).toBe(false);
    } finally {
      onDisk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("markInterruptedStreams", () => {
  it("turns streaming messages into interrupted ones", () => {
    const { id } = store.createConversation({ title: "t", modelId: null });
    const streaming = add(id, "assistant", "par", "streaming");
    const done = add(id, "assistant", "ok");
    clock = 9_000;
    expect(store.markInterruptedStreams()).toBe(1);
    expect(store.getMessage(streaming.id)).toMatchObject({
      status: "interrupted",
      content: "par",
      updatedAt: 9_000,
    });
    expect(store.getMessage(done.id)?.status).toBe("complete");
    expect(store.markInterruptedStreams()).toBe(0);
  });
});

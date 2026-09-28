// L2 repo additions: the single pending proposal of a target and the message positions a
// conversation summary is cut at.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createCompactionRepo, type NewCompactionSummary } from "./compaction";

let store: NovaStore;
let clock: number;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:", { now });
});
afterEach(() => store.close());

function summaryFor(conversationId: string): NewCompactionSummary {
  return {
    target: { kind: "conversation", conversationId },
    kind: "compaction",
    reason: "manual",
    summary: "Résumé",
    summarizerModelId: "acme/m",
    fromModelId: null,
    toModelId: null,
    coveredUntilSeq: 2,
    tokensBefore: null,
    tokensAfter: null,
    pruned: [],
    costUsd: null,
  };
}

describe("compaction repo (L2)", () => {
  it("returns the pending proposal of a target only while it waits for a decision", () => {
    const repo = createCompactionRepo(store.db, now);
    const conversationId = store.createConversation({ title: "c", modelId: null }).id;
    const other = store.createConversation({ title: "d", modelId: null }).id;
    const target = { kind: "conversation" as const, conversationId };
    expect(repo.pending(target)).toBeNull();
    const proposed = repo.insert(summaryFor(conversationId));
    repo.insert(summaryFor(other));
    expect(repo.pending(target)?.id).toBe(proposed.id);
    repo.decide(proposed.id, "dismissed");
    expect(repo.pending(target)).toBeNull();
  });

  it("lists a conversation's message positions in order, gaps from deleted messages included", () => {
    const repo = createCompactionRepo(store.db, now);
    const conversationId = store.createConversation({ title: "c", modelId: null }).id;
    const ids = ["a", "b", "c"].map(
      (content) => store.insertMessage({ conversationId, role: "user", content, status: "complete", modelId: null }).id,
    );
    store.deleteMessage(ids[1] ?? "");
    const seqs = repo.conversationMessageSeqs(conversationId);
    expect(seqs.map((row) => row.id)).toEqual([ids[0], ids[2]]);
    const [first, last] = seqs;
    expect(first && last && last.seq > first.seq + 1).toBe(true);
    expect(repo.conversationMessageSeqs("unknown")).toEqual([]);
  });
});

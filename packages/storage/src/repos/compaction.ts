// Compaction summaries and handoff dossiers (C7/A15, J2-B L2). A summary is shown before it is
// applied: rows start `proposed` and only an explicit decision applies or dismisses them.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CompactionKind,
  CompactionReason,
  CompactionStatus,
  CompactionSummary,
  ContextTarget,
  HandoffDossier,
  PrunedToolResult,
} from "@nova/shared";
import { jsonOrNull, readJsonOrNull, readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

export type NewCompactionSummary = Omit<CompactionSummary, "id" | "status" | "createdAt" | "decidedAt">;

export interface CompactionRepo {
  /** Inserts a summary in `proposed`; a handoff also stores its dossier (summaryId filled in). */
  insert(input: NewCompactionSummary, dossier?: Omit<HandoffDossier, "summaryId" | "createdAt"> | null): CompactionSummary;
  get(id: string): CompactionSummary | null;
  /** The dossier of a handoff summary; null for a compaction or an unknown id. */
  dossier(id: string): HandoffDossier | null;
  /** Oldest first. */
  list(target: ContextTarget): CompactionSummary[];
  /** The most recent `applied` summary of the target (what replaces the history), if any. */
  latestApplied(target: ContextTarget): CompactionSummary | null;
  /** The summary of the target still waiting for a decision (at most one is ever pending). */
  pending(target: ContextTarget): CompactionSummary | null;
  /** Only a `proposed` summary can be decided; returns null otherwise (unknown or already decided). */
  decide(id: string, status: Exclude<CompactionStatus, "proposed">): CompactionSummary | null;
  /**
   * Stored position (`messages.seq`) of each message of a conversation, oldest first. A
   * conversation summary's `coveredUntilSeq` is a message seq; the shared `Message` type carries
   * no seq, so the history sent after a summary is cut by id through this map.
   */
  conversationMessageSeqs(conversationId: string): { id: string; seq: number }[];
}

function targetOf(row: Row): ContextTarget {
  const missionId = readTextOrNull(row, "mission_id");
  // Exactly one target is set (CHECK constraint).
  return missionId !== null ? { kind: "mission", missionId } : { kind: "conversation", conversationId: readText(row, "conversation_id") };
}

function toSummary(row: Row): CompactionSummary {
  return {
    id: readText(row, "id"),
    target: targetOf(row),
    // Enum columns are guarded by CHECK constraints.
    kind: readText(row, "kind") as CompactionKind,
    reason: readText(row, "reason") as CompactionReason,
    status: readText(row, "status") as CompactionStatus,
    summary: readText(row, "summary"),
    summarizerModelId: readTextOrNull(row, "summarizer_model_id"),
    fromModelId: readTextOrNull(row, "from_model_id"),
    toModelId: readTextOrNull(row, "to_model_id"),
    coveredUntilSeq: readNumber(row, "covered_until_seq"),
    tokensBefore: readNumberOrNull(row, "tokens_before"),
    tokensAfter: readNumberOrNull(row, "tokens_after"),
    pruned: readJsonOrNull<PrunedToolResult[]>(row, "pruned_json") ?? [],
    costUsd: readNumberOrNull(row, "cost"),
    createdAt: readNumber(row, "created_at"),
    decidedAt: readNumberOrNull(row, "decided_at"),
  };
}

function targetColumns(target: ContextTarget): [string | null, string | null] {
  return target.kind === "mission" ? [target.missionId, null] : [null, target.conversationId];
}

export function createCompactionRepo(db: DatabaseSync, now: () => number = Date.now): CompactionRepo {
  const get = (id: string): CompactionSummary | null => {
    const row = db.prepare("SELECT * FROM compaction_summaries WHERE id = ?").get(id);
    return row ? toSummary(row) : null;
  };
  const byTarget = (target: ContextTarget, extra: string, order: string, limit: number | null): Row[] => {
    const [missionId, conversationId] = targetColumns(target);
    const column = missionId !== null ? "mission_id" : "conversation_id";
    const sql = `SELECT * FROM compaction_summaries WHERE ${column} = ? ${extra} ORDER BY ${order}${limit === null ? "" : ` LIMIT ${limit}`}`;
    return db.prepare(sql).all(missionId ?? conversationId);
  };

  return {
    insert(input, dossier = null) {
      const id = randomUUID();
      const time = now();
      const [missionId, conversationId] = targetColumns(input.target);
      const storedDossier = dossier ? { ...dossier, summaryId: id, createdAt: time } : null;
      db.prepare(
        `INSERT INTO compaction_summaries (id, mission_id, conversation_id, kind, reason, status, summary, dossier_json,
           summarizer_model_id, from_model_id, to_model_id, covered_until_seq, tokens_before, tokens_after, pruned_json,
           cost, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        id,
        missionId,
        conversationId,
        input.kind,
        input.reason,
        input.summary,
        jsonOrNull(storedDossier),
        input.summarizerModelId,
        input.fromModelId,
        input.toModelId,
        input.coveredUntilSeq,
        input.tokensBefore,
        input.tokensAfter,
        JSON.stringify(input.pruned),
        input.costUsd,
        time,
      );
      const created = get(id);
      if (!created) throw new Error("Inserted compaction summary not found");
      return created;
    },

    get,

    dossier(id) {
      const row = db.prepare("SELECT dossier_json FROM compaction_summaries WHERE id = ?").get(id);
      return row ? readJsonOrNull<HandoffDossier>(row, "dossier_json") : null;
    },

    list(target) {
      return byTarget(target, "", "created_at, rowid", null).map(toSummary);
    },

    latestApplied(target) {
      const row = byTarget(target, "AND status = 'applied'", "decided_at DESC, rowid DESC", 1)[0];
      return row ? toSummary(row) : null;
    },

    pending(target) {
      const row = byTarget(target, "AND status = 'proposed'", "created_at DESC, rowid DESC", 1)[0];
      return row ? toSummary(row) : null;
    },

    conversationMessageSeqs(conversationId) {
      return db
        .prepare("SELECT id, seq FROM messages WHERE conversation_id = ? ORDER BY seq")
        .all(conversationId)
        .map((row) => ({ id: readText(row, "id"), seq: readNumber(row, "seq") }));
    },

    decide(id, status) {
      const result = db
        .prepare("UPDATE compaction_summaries SET status = ?, decided_at = ? WHERE id = ? AND status = 'proposed'")
        .run(status, now(), id);
      return Number(result.changes) > 0 ? get(id) : null;
    },
  };
}

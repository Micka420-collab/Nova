// Mission budget (A13/Mo5/Mo6): reservations taken BEFORE each paid call inside one transaction,
// settled with the reported cost afterwards; a call whose cost stays unknown keeps its estimate
// (conservative), so the cap still holds. Usage rows carry the real reported cost (or NULL).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../sqlite";

export type UsageKindValue = "generation" | "web_search" | "ocr" | "embedding";

export interface CostReservation {
  id: string;
  missionId: string;
  amountUsd: number;
}

export type ReserveResult =
  | { ok: true; reservation: CostReservation }
  | { ok: false; reason: "budget" | "daily_budget"; availableUsd: number };

export interface MissionUsageInput {
  missionId: string;
  toolCallId: string | null;
  kind: UsageKindValue;
  providerId: string;
  modelId: string;
  servedModel: string | null;
  servedProvider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  cost: number | null;
}

export interface MissionCostSummary {
  /** Reservations not settled yet. */
  reservedUsd: number;
  /** Settled amounts (reported costs, or the estimate when the cost stayed unknown). */
  committedUsd: number;
  /** Sum of reported costs of the mission (a lower bound when unknownCostCalls > 0). */
  spentUsd: number;
  unknownCostCalls: number;
  /** Reported costs of every usage today (chat included) plus every open call reservation. */
  dailySpentUsd: number;
  /** Per model and kind (Mo6). */
  byModel: { modelId: string; kind: UsageKindValue; calls: number; promptTokens: number; completionTokens: number; costUsd: number; unknownCostCalls: number }[];
}

export interface CostRepo {
  reserve(input: {
    missionId: string;
    amountUsd: number;
    /** null = no mission cap. */
    missionBudgetUsd: number | null;
    /** null = no daily cap. */
    dailyLimitUsd: number | null;
    /** Start of the current local day (ms). */
    dayStart: number;
    /**
     * A parent's hold for a sub-mission: counted against the parent's budget, never in the day's
     * total (the child's own calls are). Default false.
     */
    backsSubmission?: boolean;
  }): ReserveResult;
  /** Settles with the reported cost; null keeps the reserved estimate as committed. Idempotent. */
  settle(reservationId: string, actualUsd: number | null): void;
  /** Cancels a reservation whose call never happened. Idempotent. */
  release(reservationId: string): void;
  releaseOpen(missionId: string): void;
  recordUsage(input: MissionUsageInput): void;
  summary(missionId: string, dayStart: number): MissionCostSummary;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function createCostRepo(db: DatabaseSync, now: () => number = Date.now): CostRepo {
  const missionTotals = (missionId: string): { reserved: number; committed: number } => {
    const row = db
      .prepare(
        `SELECT
           coalesce(sum(CASE WHEN status = 'reserved' THEN amount_usd END), 0) AS reserved,
           coalesce(sum(CASE WHEN status = 'committed' THEN settled_amount_usd END), 0) AS committed
         FROM cost_reservations WHERE mission_id = ?`,
      )
      .get(missionId);
    return { reserved: num(row?.["reserved"]), committed: num(row?.["committed"]) };
  };

  const daily = (dayStart: number): number => {
    const row = db
      .prepare(
        `SELECT
           (SELECT coalesce(sum(cost), 0) FROM usage_records WHERE created_at >= ?) +
           (SELECT coalesce(sum(amount_usd), 0) FROM cost_reservations
            WHERE status = 'reserved' AND backs_submission = 0) AS total`,
      )
      .get(dayStart);
    return num(row?.["total"]);
  };

  return {
    reserve(input) {
      return withTransaction(db, (): ReserveResult => {
        const totals = missionTotals(input.missionId);
        if (input.missionBudgetUsd !== null) {
          const available = input.missionBudgetUsd - totals.committed - totals.reserved;
          if (input.amountUsd > available) return { ok: false, reason: "budget", availableUsd: Math.max(0, available) };
        }
        if (input.dailyLimitUsd !== null) {
          const available = input.dailyLimitUsd - daily(input.dayStart);
          if (input.amountUsd > available) return { ok: false, reason: "daily_budget", availableUsd: Math.max(0, available) };
        }
        const id = randomUUID();
        db.prepare(
          `INSERT INTO cost_reservations (id, mission_id, amount_usd, status, created_at, backs_submission)
           VALUES (?, ?, ?, 'reserved', ?, ?)`,
        ).run(id, input.missionId, input.amountUsd, now(), input.backsSubmission === true ? 1 : 0);
        return { ok: true, reservation: { id, missionId: input.missionId, amountUsd: input.amountUsd } };
      });
    },

    settle(reservationId, actualUsd) {
      db.prepare(
        `UPDATE cost_reservations
         SET status = 'committed', settled_at = ?, settled_amount_usd = coalesce(?, amount_usd)
         WHERE id = ? AND status = 'reserved'`,
      ).run(now(), actualUsd, reservationId);
    },

    release(reservationId) {
      db.prepare(
        `UPDATE cost_reservations SET status = 'released', settled_at = ?, settled_amount_usd = 0
         WHERE id = ? AND status = 'reserved'`,
      ).run(now(), reservationId);
    },

    releaseOpen(missionId) {
      db.prepare(
        `UPDATE cost_reservations SET status = 'released', settled_at = ?, settled_amount_usd = 0
         WHERE mission_id = ? AND status = 'reserved'`,
      ).run(now(), missionId);
    },

    recordUsage(input) {
      db.prepare(
        `INSERT INTO usage_records
           (id, conversation_id, message_id, mission_id, tool_call_id, kind, provider_id, model_id,
            served_model, served_provider, prompt_tokens, completion_tokens, reasoning_tokens,
            cached_tokens, cost, created_at)
         VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.missionId,
        input.toolCallId,
        input.kind,
        input.providerId,
        input.modelId,
        input.servedModel,
        input.servedProvider,
        input.promptTokens,
        input.completionTokens,
        input.reasoningTokens,
        input.cachedTokens,
        input.cost,
        now(),
      );
    },

    summary(missionId, dayStart) {
      const totals = missionTotals(missionId);
      const usage = db
        .prepare(
          `SELECT coalesce(sum(cost), 0) AS spent, count(*) - count(cost) AS unknown
           FROM usage_records WHERE mission_id = ?`,
        )
        .get(missionId);
      const byModel = db
        .prepare(
          `SELECT model_id, kind, count(*) AS calls, coalesce(sum(prompt_tokens), 0) AS prompt,
                  coalesce(sum(completion_tokens), 0) AS completion, coalesce(sum(cost), 0) AS cost,
                  count(*) - count(cost) AS unknown
           FROM usage_records WHERE mission_id = ? GROUP BY model_id, kind ORDER BY model_id, kind`,
        )
        .all(missionId)
        .map((row) => ({
          modelId: String(row["model_id"]),
          kind: String(row["kind"]) as UsageKindValue,
          calls: num(row["calls"]),
          promptTokens: num(row["prompt"]),
          completionTokens: num(row["completion"]),
          costUsd: num(row["cost"]),
          unknownCostCalls: num(row["unknown"]),
        }));
      return {
        reservedUsd: totals.reserved,
        committedUsd: totals.committed,
        spentUsd: num(usage?.["spent"]),
        unknownCostCalls: num(usage?.["unknown"]),
        dailySpentUsd: daily(dayStart),
        byModel,
      };
    },
  };
}

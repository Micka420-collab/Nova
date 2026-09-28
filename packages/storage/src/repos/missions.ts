// Missions (A9) with their autonomy contract (A13) and append-only event journal.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  readJsonOrNull,
  readNumber,
  readNumberOrNull,
  readText,
  readTextOrNull,
  withTransaction,
  type Row,
} from "../sqlite";
import { createCostRepo, type CostRepo } from "./cost";
import { createReviewRepo, type ReviewRepo } from "./missions-review";
import { createProofRepo, type ProofRepo } from "./proofs";
import { createToolCallRepo, type ToolCallRepo } from "./tool-calls";
import type { PermissionProfileValue } from "./workspaces";

/** Mirrors the work mode union of @nova/shared (A12). */
export type WorkModeValue = "discuss" | "understand" | "plan" | "build" | "fix" | "verify";
/** Mirrors the mission state union of @nova/shared. */
export type MissionStateValue =
  | "ready"
  | "running"
  | "waiting_approval"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";
/** Mirrors the operation class union of @nova/shared (S1). */
export type OperationClassValue =
  | "read"
  | "write"
  | "delete"
  | "execute"
  | "network"
  | "git_mutation"
  | "external";
/** Mirrors the isolation level union of @nova/shared (S3). */
export type IsolationLevelValue = "L0" | "L1" | "L2";

export interface MissionContractRecord {
  profile: PermissionProfileValue;
  isolationLevel: IsolationLevelValue;
  allowedOperations: OperationClassValue[];
  allowedHosts: string[];
  /** null = no duration cap. */
  maxDurationMs: number | null;
  /** null = no budget cap. */
  budgetUsd: number | null;
  createdAt: number;
}

export interface MissionRecord {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  title: string;
  goal: string;
  mode: WorkModeValue;
  state: MissionStateValue;
  modelId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  contract: MissionContractRecord | null;
}

export interface MissionEventRecord {
  /** Monotonic across the database; orders the events of a mission. */
  seq: number;
  id: string;
  missionId: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface NewMission {
  workspaceId: string;
  conversationId: string | null;
  title: string;
  goal: string;
  mode: WorkModeValue;
  modelId: string | null;
  contract: Omit<MissionContractRecord, "createdAt">;
}

export type MissionTaskStateValue = "todo" | "running" | "verified" | "failed" | "blocked" | "skipped";
export type AcceptanceKindValue = "test_passes" | "command_succeeds" | "file_exists" | "manual";

export interface MissionTaskRecord {
  id: string;
  missionId: string;
  seq: number;
  title: string;
  state: MissionTaskStateValue;
  acceptance: { kind: AcceptanceKindValue; detail: string };
  updatedAt: number;
}

export interface MissionTaskDraftRecord {
  title: string;
  acceptance: { kind: AcceptanceKindValue; detail: string };
}

export interface MissionRepo {
  /** Sub-repositories over the same handle (tool calls, proofs, budget, review decisions). */
  readonly toolCalls: ToolCallRepo;
  readonly proofs: ProofRepo;
  readonly cost: CostRepo;
  readonly reviews: ReviewRepo;
  /** Creates the mission in state `ready` together with its contract (one transaction). */
  create(input: NewMission): MissionRecord;
  get(id: string): MissionRecord | null;
  /** Appends to the journal; `payload` must be JSON-serializable and free of secrets. */
  appendEvent(missionId: string, type: string, payload: unknown): MissionEventRecord;
  /** Chronological; `afterSeq` resumes a replay after the last event already seen. */
  listEvents(missionId: string, afterSeq?: number): MissionEventRecord[];
  /** Last `limit` events (chronological), for the mission card. */
  listRecentEvents(missionId: string, limit: number): MissionEventRecord[];
  /** Updates the state; `startedAt`/`endedAt` are set once (first value wins). */
  setState(id: string, state: MissionStateValue, stamps?: { startedAt?: number; endedAt?: number }): MissionRecord | null;
  updateContract(id: string, contract: Omit<MissionContractRecord, "createdAt">): void;
  /** A15: the model of the mission after a handoff; returns null for an unknown mission. */
  setModel(id: string, modelId: string): MissionRecord | null;
  /** Most recently updated first; `workspaceId` null = every workspace. */
  list(workspaceId: string | null, limit: number): { items: MissionRecord[]; hasMore: boolean };
  /** Missions left in a non-terminal, non-ready state (for recovery after a restart). */
  listInterrupted(): MissionRecord[];
  /** Replaces the plan (tasks renumbered from 0). */
  replaceTasks(missionId: string, drafts: MissionTaskDraftRecord[]): MissionTaskRecord[];
  listTasks(missionId: string): MissionTaskRecord[];
  setTaskState(taskId: string, state: MissionTaskStateValue): MissionTaskRecord | null;
}

function toContract(row: Row): MissionContractRecord {
  return {
    // Enum columns are guarded by CHECK constraints.
    profile: readText(row, "profile") as PermissionProfileValue,
    isolationLevel: readText(row, "isolation_level") as IsolationLevelValue,
    allowedOperations: readJsonOrNull<OperationClassValue[]>(row, "allowed_operations_json") ?? [],
    allowedHosts: readJsonOrNull<string[]>(row, "allowed_hosts_json") ?? [],
    maxDurationMs: readNumberOrNull(row, "max_duration_ms"),
    budgetUsd: readNumberOrNull(row, "budget_usd"),
    createdAt: readNumber(row, "contract_created_at"),
  };
}

function toMission(row: Row): MissionRecord {
  return {
    id: readText(row, "id"),
    workspaceId: readText(row, "workspace_id"),
    conversationId: readTextOrNull(row, "conversation_id"),
    title: readText(row, "title"),
    goal: readText(row, "goal"),
    mode: readText(row, "mode") as WorkModeValue,
    state: readText(row, "state") as MissionStateValue,
    modelId: readTextOrNull(row, "model_id"),
    createdAt: readNumber(row, "created_at"),
    startedAt: readNumberOrNull(row, "started_at"),
    endedAt: readNumberOrNull(row, "ended_at"),
    updatedAt: readNumber(row, "updated_at"),
    contract: row["profile"] === null ? null : toContract(row),
  };
}

function toTask(row: Row): MissionTaskRecord {
  return {
    id: readText(row, "id"),
    missionId: readText(row, "mission_id"),
    seq: readNumber(row, "seq"),
    title: readText(row, "title"),
    state: readText(row, "state") as MissionTaskStateValue,
    acceptance: {
      kind: readText(row, "acceptance_kind") as AcceptanceKindValue,
      detail: readText(row, "acceptance_detail"),
    },
    updatedAt: readNumber(row, "updated_at"),
  };
}

function toEvent(row: Row): MissionEventRecord {
  return {
    seq: readNumber(row, "seq"),
    id: readText(row, "id"),
    missionId: readText(row, "mission_id"),
    type: readText(row, "type"),
    payload: readJsonOrNull<unknown>(row, "payload_json"),
    createdAt: readNumber(row, "created_at"),
  };
}

export function createMissionRepo(db: DatabaseSync, now: () => number = Date.now): MissionRepo {
  const SELECT_MISSION = `SELECT m.*, c.profile, c.isolation_level, c.allowed_operations_json, c.allowed_hosts_json,
                c.max_duration_ms, c.budget_usd, c.created_at AS contract_created_at
         FROM missions m LEFT JOIN mission_contracts c ON c.mission_id = m.id`;
  const get = (id: string): MissionRecord | null => {
    const row = db.prepare(`${SELECT_MISSION} WHERE m.id = ?`).get(id);
    return row ? toMission(row) : null;
  };
  const listTasks = (missionId: string): MissionTaskRecord[] =>
    db.prepare("SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY seq").all(missionId).map(toTask);

  return {
    toolCalls: createToolCallRepo(db, now),
    proofs: createProofRepo(db, now),
    cost: createCostRepo(db, now),
    reviews: createReviewRepo(db, now),

    create(input) {
      const id = randomUUID();
      const time = now();
      const { contract } = input;
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO missions
             (id, workspace_id, conversation_id, title, goal, mode, state, model_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
        ).run(
          id,
          input.workspaceId,
          input.conversationId,
          input.title,
          input.goal,
          input.mode,
          input.modelId,
          time,
          time,
        );
        db.prepare(
          `INSERT INTO mission_contracts
             (mission_id, profile, isolation_level, allowed_operations_json, allowed_hosts_json,
              max_duration_ms, budget_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          contract.profile,
          contract.isolationLevel,
          JSON.stringify(contract.allowedOperations),
          JSON.stringify(contract.allowedHosts),
          contract.maxDurationMs,
          contract.budgetUsd,
          time,
        );
      });
      const created = get(id);
      if (!created) throw new Error("Created mission not found");
      return created;
    },

    get,

    appendEvent(missionId, type, payload) {
      const row = db
        .prepare(
          `INSERT INTO mission_events (id, mission_id, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(randomUUID(), missionId, type, JSON.stringify(payload ?? null), now());
      if (!row) throw new Error("Event insert returned no row");
      return toEvent(row);
    },

    listEvents(missionId, afterSeq = 0) {
      return db
        .prepare("SELECT * FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq")
        .all(missionId, afterSeq)
        .map(toEvent);
    },

    listRecentEvents(missionId, limit) {
      return db
        .prepare("SELECT * FROM (SELECT * FROM mission_events WHERE mission_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq")
        .all(missionId, limit)
        .map(toEvent);
    },

    setState(id, state, stamps = {}) {
      db.prepare(
        `UPDATE missions SET state = ?, updated_at = ?,
           started_at = coalesce(started_at, ?), ended_at = coalesce(ended_at, ?)
         WHERE id = ?`,
      ).run(state, now(), stamps.startedAt ?? null, stamps.endedAt ?? null, id);
      return get(id);
    },

    setModel(id, modelId) {
      db.prepare("UPDATE missions SET model_id = ?, updated_at = ? WHERE id = ?").run(modelId, now(), id);
      return get(id);
    },

    updateContract(id, contract) {
      db.prepare(
        `UPDATE mission_contracts SET profile = ?, isolation_level = ?, allowed_operations_json = ?,
           allowed_hosts_json = ?, max_duration_ms = ?, budget_usd = ?
         WHERE mission_id = ?`,
      ).run(
        contract.profile,
        contract.isolationLevel,
        JSON.stringify(contract.allowedOperations),
        JSON.stringify(contract.allowedHosts),
        contract.maxDurationMs,
        contract.budgetUsd,
        id,
      );
    },

    list(workspaceId, limit) {
      const rows =
        workspaceId === null
          ? db.prepare(`${SELECT_MISSION} ORDER BY m.updated_at DESC, m.rowid DESC LIMIT ?`).all(limit + 1)
          : db.prepare(`${SELECT_MISSION} WHERE m.workspace_id = ? ORDER BY m.updated_at DESC, m.rowid DESC LIMIT ?`).all(workspaceId, limit + 1);
      return { items: rows.slice(0, limit).map(toMission), hasMore: rows.length > limit };
    },

    listInterrupted() {
      return db
        .prepare(`${SELECT_MISSION} WHERE m.state IN ('running', 'waiting_approval', 'suspended') ORDER BY m.created_at`)
        .all()
        .map(toMission);
    },

    replaceTasks(missionId, drafts) {
      const time = now();
      withTransaction(db, () => {
        db.prepare("DELETE FROM mission_tasks WHERE mission_id = ?").run(missionId);
        const insert = db.prepare(
          `INSERT INTO mission_tasks (id, mission_id, seq, title, state, acceptance_kind, acceptance_detail, updated_at)
           VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)`,
        );
        drafts.forEach((draft, seq) =>
          insert.run(randomUUID(), missionId, seq, draft.title, draft.acceptance.kind, draft.acceptance.detail, time),
        );
      });
      return listTasks(missionId);
    },

    listTasks,

    setTaskState(taskId, state) {
      const row = db
        .prepare("UPDATE mission_tasks SET state = ?, updated_at = ? WHERE id = ? RETURNING *")
        .get(state, now(), taskId);
      return row ? toTask(row) : null;
    },
  };
}

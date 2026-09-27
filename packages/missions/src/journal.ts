// Mission journal (main side): appends to `mission_events`, projects the mission state, pushes
// to the renderer. It is the last line of defense of the terminal invariant: after a terminal
// event, only `review.decided` and `budget.updated` are accepted; a second terminal is dropped.
import { randomUUID } from "node:crypto";
import {
  LIVE_ONLY_MISSION_EVENTS,
  TERMINAL_MISSION_EVENTS,
  type MissionEvent,
  type MissionEventType,
  type MissionState,
} from "@nova/shared";
import type { MissionEventInput } from "./index";

export interface MissionEventRecordLike {
  seq: number;
  id: string;
  missionId: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface MissionJournalDeps {
  store: {
    appendEvent(missionId: string, type: string, payload: unknown): MissionEventRecordLike;
    listEvents(missionId: string, afterSeq?: number): MissionEventRecordLike[];
    setState(id: string, state: MissionState, stamps?: { startedAt?: number; endedAt?: number }): unknown;
  };
  /** Live push to the renderer (every accepted event, live-only ones included). */
  push(event: MissionEvent): void;
  /** Called once when a mission reaches its terminal event (cleanup: reservations, processes). */
  onTerminal?(event: MissionEvent): void;
  now?: () => number;
}

export interface MissionJournal {
  /** Returns the accepted event, or null when the invariant dropped it. */
  append(event: MissionEventInput): MissionEvent | null;
  isTerminated(missionId: string): boolean;
}

const AFTER_TERMINAL: readonly MissionEventType[] = ["review.decided", "budget.updated"];

const STATE_OF: Partial<Record<MissionEventType, MissionState>> = {
  "mission.started": "running",
  "approval.requested": "waiting_approval",
  "approval.resolved": "running",
  "mission.suspended": "suspended",
  "mission.resumed": "running",
  "mission.succeeded": "succeeded",
  "mission.failed": "failed",
  "mission.cancelled": "cancelled",
};

/** Rebuilds a typed event from its stored row (payload = event minus id/seq/at/type/missionId). */
export function eventFromRecord(record: MissionEventRecordLike): MissionEvent {
  const payload = typeof record.payload === "object" && record.payload !== null ? record.payload : {};
  return { ...payload, id: record.id, missionId: record.missionId, seq: record.seq, at: record.createdAt, type: record.type } as MissionEvent;
}

function payloadOf(event: MissionEventInput): Record<string, unknown> {
  const { type: _type, missionId: _missionId, ...payload } = event as MissionEventInput & Record<string, unknown>;
  return payload;
}

export function createMissionJournal(deps: MissionJournalDeps): MissionJournal {
  const now = deps.now ?? Date.now;
  const terminated = new Map<string, boolean>();

  const isTerminated = (missionId: string): boolean => {
    const known = terminated.get(missionId);
    if (known !== undefined) return known;
    const value = deps.store.listEvents(missionId).some((record) => TERMINAL_MISSION_EVENTS.includes(record.type as MissionEventType));
    terminated.set(missionId, value);
    return value;
  };

  return {
    isTerminated,
    append(event) {
      const done = isTerminated(event.missionId);
      if (done && !AFTER_TERMINAL.includes(event.type)) return null;

      if (LIVE_ONLY_MISSION_EVENTS.includes(event.type)) {
        // Live-only: pushed, never stored; seq 0 marks "not in the log".
        const live = { ...event, id: randomUUID(), seq: 0, at: now() } as MissionEvent;
        deps.push(live);
        return live;
      }

      const record = deps.store.appendEvent(event.missionId, event.type, payloadOf(event));
      const stored = eventFromRecord(record);
      const state = STATE_OF[event.type];
      if (state) {
        const at = record.createdAt;
        const terminal = TERMINAL_MISSION_EVENTS.includes(event.type);
        deps.store.setState(event.missionId, state, event.type === "mission.started" ? { startedAt: at } : terminal ? { endedAt: at } : {});
        if (terminal) terminated.set(event.missionId, true);
      }
      deps.push(stored);
      if (TERMINAL_MISSION_EVENTS.includes(event.type)) deps.onTerminal?.(stored);
      return stored;
    },
  };
}

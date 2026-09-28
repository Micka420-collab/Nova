// L8 timeline: search over the journal of every mission, and fork a mission from one of its
// events. Main side of the `timeline.*` IPC group.
// - Search: the index holds stored payloads (JSON). A hit is kept only when every term matches
//   the event's human text (not a JSON key nor an id), and its excerpt is built from that text,
//   redacted as a whole BEFORE being cut (a cut never splits a secret out of the redaction).
// - Fork: a NEW mission, planned like any other (`ready`, new plan, new contract to accept, new
//   approvals), whose goal carries a recap of the original up to the chosen event. Nothing is
//   replayed and the original is never modified; the link (kind `fork`) and `mission.forked`
//   record where it comes from.
import {
  redactSecrets,
  type Mission,
  type MissionContract,
  type MissionContractInput,
  type MissionEvent,
  type MissionEventType,
  type MissionForkRequest,
  type MissionPlanRequest,
  type MissionPlanResult,
  type MissionTask,
  type TimelineHit,
  type TimelineSearchRequest,
} from "@nova/shared";
import { MissionError } from "../controller";
import type { MissionEventInput } from "../index";

export interface TimelineService {
  search(request: TimelineSearchRequest): Promise<TimelineHit[]>;
  fork(request: MissionForkRequest): Promise<MissionPlanResult>;
}

/** One raw hit of the index (`createTimelineSearchRepo` of @nova/storage). */
export interface TimelineSearchRecordLike {
  missionId: string;
  missionTitle: string;
  seq: number;
  type: MissionEventType;
  at: number;
  /** Stored payload JSON (unredacted). */
  payload: string;
}

export interface TimelineServiceDeps {
  search: { search(input: { query: string; workspaceId: string | null; missionId: string | null; limit: number }): TimelineSearchRecordLike[] };
  missions: {
    get(id: string): Pick<Mission, "id" | "workspaceId" | "title" | "goal" | "mode" | "modelId"> | null;
    /** Stored events of the mission, oldest first, typed (`listEvents` + `eventFromRecord`). */
    events(missionId: string): readonly MissionEvent[];
  };
  /** `MissionController.contractOf`. */
  contractOf(missionId: string): MissionContract | null;
  /** `MissionController.plan`: the fork is planned like any mission (paid call on ITS budget). */
  plan(request: MissionPlanRequest): Promise<MissionPlanResult>;
  /** `createMissionLinkRepo(db).insert`. */
  links: {
    insert(input: {
      childMissionId: string;
      parentMissionId: string;
      kind: "fork";
      forkSeq: number;
      depth: number;
      reservedUsd: null;
      worktree: null;
      integration: null;
    }): unknown;
  };
  /** `MissionController.journal`. */
  journal: { append(event: MissionEventInput): MissionEvent | null };
}

export const TIMELINE_LIMITS = {
  /** Displayed excerpt (TimelineHit.snippet contract). */
  snippetMaxChars: 300,
  /** Characters kept before the first match in an excerpt. */
  snippetLeadChars: 90,
  /** Human text read from one payload (a mission goal can be 20 000 characters). */
  eventTextMaxChars: 24_000,
  /** Index rows read per requested hit (rows whose only match is a key or an id are dropped). */
  overfetch: 4,
  maxIndexRows: 800,
  /** Recap of the original mission put in the fork's goal. */
  recapMaxChars: 6_000,
  recapActions: 20,
  recapAnswerChars: 1_200,
  goalMaxChars: 20_000,
} as const;

/** Payload keys whose values are identifiers or hashes, never something a person searches for. */
const ID_KEYS = new Set([
  "id",
  "missionId",
  "workspaceId",
  "conversationId",
  "callId",
  "taskId",
  "toolCallId",
  "providerCallId",
  "parentCallId",
  "approvalId",
  "messageId",
  "summaryId",
  "handoffSummaryId",
  "sessionId",
  "checkpointId",
  "outputRef",
  "artifactId",
  "contentHash",
  "beforeHash",
  "currentHash",
  "hash",
  "fromMissionId",
  "childMissionId",
  "parentMissionId",
  "unprovenTaskIds",
  "reservationId",
]);
const ID_LIKE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})$/i;

/** Split like the index tokenizer (`unicode61`): letters, digits, marks form words. */
function queryTermsOf(query: string): string[] {
  return query
    .normalize("NFC")
    .split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 16)
    .map((term) => fold(term).text);
}

/** Lower case without diacritics, with the index in `source` of each folded character. */
function fold(source: string): { text: string; origin: number[] } {
  let text = "";
  const origin: number[] = [];
  let index = 0;
  for (const char of source) {
    const folded = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let i = 0; i < folded.length; i += 1) origin.push(index);
    text += folded;
    index += char.length;
  }
  return { text, origin };
}

/** Human text of a stored payload: string values, ids and hashes excluded, in payload order. */
export function eventText(payload: string, maxChars: number = TIMELINE_LIMITS.eventTextMaxChars): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "";
  }
  const parts: string[] = [];
  let length = 0;
  const walk = (value: unknown, key: string | null): void => {
    if (length >= maxChars) return;
    if (key !== null && ID_KEYS.has(key)) return;
    if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim();
      if (text.length === 0 || ID_LIKE.test(text)) return;
      parts.push(text);
      length += text.length + 3;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    }
  };
  walk(parsed, null);
  const text = parts.join(" · ");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

interface Word {
  start: number;
  text: string;
}

function wordsOf(folded: string): Word[] {
  return [...folded.matchAll(/[\p{L}\p{N}\p{Co}]+/gu)].map((match) => ({ start: match.index, text: match[0] }));
}

/**
 * Where the query matches `text` like the index does (every term a word, the last one a word
 * prefix), as the offset in `text` of the first matched word; null = no match.
 */
export function matchOffset(text: string, terms: readonly string[]): number | null {
  if (terms.length === 0) return null;
  const folded = fold(text);
  const words = wordsOf(folded.text);
  let first: number | null = null;
  for (const [index, term] of terms.entries()) {
    const prefix = index === terms.length - 1;
    const word = words.find((candidate) => (prefix ? candidate.text.startsWith(term) : candidate.text === term));
    if (!word) return null;
    const offset = folded.origin[word.start] ?? 0;
    first = first === null ? offset : Math.min(first, offset);
  }
  return first;
}

/** An excerpt of at most `snippetMaxChars` around `offset`, with ellipses where it was cut. */
export function excerptAt(text: string, offset: number): string {
  const max = TIMELINE_LIMITS.snippetMaxChars;
  if (text.length <= max) return text;
  let start = Math.max(0, offset - TIMELINE_LIMITS.snippetLeadChars);
  if (start + max > text.length) start = Math.max(0, text.length - max);
  const head = start > 0 ? "…" : "";
  const room = max - head.length;
  const body = text.slice(start, start + room);
  const tail = start + room < text.length ? "…" : "";
  return `${head}${tail ? body.slice(0, room - 1) : body}${tail}`;
}

// ---------------------------------------------------------------------------
// Fork recap

const TOOL_STATE_FR = { succeeded: "réussi", failed: "échoué", cancelled: "annulé", denied: "refusé" } as const;
const TASK_STATE_FR: Record<MissionTask["state"], string> = {
  todo: "à faire",
  running: "en cours",
  verified: "vérifiée",
  failed: "en échec",
  blocked: "bloquée",
  skipped: "sautée",
};

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What the original mission had done up to `atSeq`, in French (it is part of the fork's goal,
 * shown to the user and read by the model). Only stored facts; redacted; bounded.
 */
export function buildForkRecap(input: { title: string; atSeq: number; events: readonly MissionEvent[]; maxChars?: number }): string {
  const maxChars = input.maxChars ?? TIMELINE_LIMITS.recapMaxChars;
  const events = input.events.filter((event) => event.seq > 0 && event.seq <= input.atSeq);
  let planSummary: string | null = null;
  const tasks = new Map<string, MissionTask>();
  const calls = new Map<string, { name: string; target: string | null }>();
  const actions: string[] = [];
  let answer: string | null = null;
  let outcome: string | null = null;
  const continuation: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "mission.plan":
        planSummary = event.summary;
        tasks.clear();
        for (const task of event.tasks) tasks.set(task.id, task);
        break;
      case "task.updated":
        tasks.set(event.task.id, event.task);
        break;
      case "tool.requested":
        calls.set(event.call.id, { name: event.call.name, target: event.call.path ?? event.call.argv?.join(" ") ?? event.call.host ?? null });
        break;
      case "tool.finished": {
        const call = calls.get(event.callId);
        const label = call ? `${call.name}${call.target ? ` ${oneLine(call.target, 120)}` : ""}` : "outil";
        actions.push(`- ${label} : ${TOOL_STATE_FR[event.state]}`);
        break;
      }
      case "message.completed":
        if (event.content.trim()) answer = event.content;
        break;
      case "continuation.round":
        continuation.push(`tour de poursuite ${event.round}/${event.maxRounds}`);
        break;
      case "continuation.stopped":
        continuation.push(`poursuite arrêtée (${event.reason})`);
        break;
      case "mission.suspended":
        outcome = `suspendue (${event.reason})`;
        break;
      case "mission.resumed":
        outcome = null;
        break;
      case "mission.succeeded":
        outcome = `réussie : ${oneLine(event.summary, 300)}`;
        break;
      case "mission.failed":
        outcome = `échouée (${event.reason}${event.detail ? ` : ${oneLine(event.detail, 300)}` : ""})`;
        break;
      case "mission.cancelled":
        outcome = "arrêtée";
        break;
      default:
        break;
    }
  }

  const lines: string[] = [
    `Reprise de la mission « ${oneLine(input.title, 120)} » à partir de son événement n° ${input.atSeq}.`,
    "Rien n'a été rejoué : le projet est dans son état actuel, pas dans celui de ce moment. Vérifie avant de te fier à ce résumé.",
  ];
  if (planSummary) lines.push("", `Plan d'origine : ${oneLine(planSummary, 600)}`);
  if (tasks.size > 0) {
    lines.push("Étapes à ce moment :");
    for (const task of [...tasks.values()].toSorted((a, b) => a.seq - b.seq)) {
      lines.push(`- [${TASK_STATE_FR[task.state]}] ${oneLine(task.title, 200)}`);
    }
  }
  if (actions.length > 0) {
    const shown = actions.slice(-TIMELINE_LIMITS.recapActions);
    lines.push("", actions.length > shown.length ? `Dernières actions (${shown.length} sur ${actions.length}) :` : "Actions faites :", ...shown);
  }
  if (continuation.length > 0) lines.push("", `Poursuite automatique : ${continuation.join(", ")}.`);
  if (answer) lines.push("", `Dernière réponse de Nomi : « ${oneLine(answer, TIMELINE_LIMITS.recapAnswerChars)} »`);
  if (outcome) lines.push("", `État de la mission d'origine à ce moment : ${outcome}.`);

  const text = redactSecrets(lines.join("\n"));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function contractInputOf(contract: MissionContract): MissionContractInput {
  return {
    profile: contract.profile,
    allowedOperations: [...contract.allowedOperations],
    allowedHosts: [...contract.allowedHosts],
    webSearch: contract.webSearch,
    maxDurationMs: contract.maxDurationMs,
    budgetUsd: contract.budgetUsd,
    ...(contract.harness ? { harness: contract.harness } : {}),
  };
}

export function createTimelineService(deps: TimelineServiceDeps): TimelineService {
  return {
    async search(request) {
      const terms = queryTermsOf(request.query);
      if (terms.length === 0) return [];
      const rows = deps.search.search({
        query: request.query,
        workspaceId: request.workspaceId,
        missionId: request.missionId,
        limit: Math.min(request.limit * TIMELINE_LIMITS.overfetch, TIMELINE_LIMITS.maxIndexRows),
      });
      const hits: TimelineHit[] = [];
      for (const row of rows) {
        if (hits.length >= request.limit) break;
        // Redacted as a whole first: the match and the excerpt only ever see redacted text.
        const text = redactSecrets(eventText(row.payload));
        const offset = matchOffset(text, terms);
        if (offset === null) continue;
        hits.push({
          missionId: row.missionId,
          missionTitle: redactSecrets(row.missionTitle),
          seq: row.seq,
          type: row.type,
          at: row.at,
          snippet: excerptAt(text, offset),
        });
      }
      return hits;
    },

    async fork(request) {
      const original = deps.missions.get(request.missionId);
      if (!original) throw new MissionError("not_found", "mission not found");
      const events = deps.missions.events(original.id);
      if (!events.some((event) => event.seq === request.atSeq)) {
        throw new MissionError("invalid_request", "this event does not belong to the mission");
      }
      const modelId = request.modelId ?? original.modelId;
      if (!modelId) throw new MissionError("invalid_request", "the mission has no model: choose one");
      const contract = deps.contractOf(original.id);
      if (!contract) throw new MissionError("not_found", "mission contract not found");

      const goal = request.goal ?? original.goal;
      const room = TIMELINE_LIMITS.goalMaxChars - goal.length - "\n\n---\n".length;
      const recap = room >= 200 ? buildForkRecap({ title: original.title, atSeq: request.atSeq, events, maxChars: Math.min(room, TIMELINE_LIMITS.recapMaxChars) }) : null;
      const result = await deps.plan({
        workspaceId: original.workspaceId,
        conversationId: null,
        goal: recap ? `${goal}\n\n---\n${recap}` : goal,
        mode: original.mode,
        modelId,
        contract: contractInputOf(contract),
      });
      const child = result.mission.id;
      deps.links.insert({
        childMissionId: child,
        parentMissionId: original.id,
        kind: "fork",
        forkSeq: request.atSeq,
        depth: 1,
        reservedUsd: null,
        worktree: null,
        integration: null,
      });
      deps.journal.append({ type: "mission.forked", missionId: child, fromMissionId: original.id, fromSeq: request.atSeq });
      return result;
    },
  };
}

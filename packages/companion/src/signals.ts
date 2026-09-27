// Signal producers (N2): recorded runtime facts → companion signals. Pure; main stores the result
// in `signals` before any suggestion may refer to it. No network, no model, no guessing.
import { redactSecrets, type Approval, type CompanionSignal, type MissionEvent } from "@nova/shared";
import { NOMI_COPY } from "./copy";
import type { MissionFacts } from "./facts";
import { shortCommand } from "./format";
import { parseTestCounts, type ProcessExitFact } from "./watch";

export type SignalDraft = Omit<CompanionSignal, "id" | "state" | "createdAt">;

/** Contract cap on evidence excerpts (companion.ts). */
export const EVIDENCE_MAX_CHARS = 2_000;

/** Redacted, trimmed, keeps the END of long output (where errors are). */
export function evidenceExcerpt(text: string | null): string | null {
  if (text === null) return null;
  const clean = redactSecrets(text).trim();
  if (clean.length === 0) return null;
  return clean.length > EVIDENCE_MAX_CHARS ? `…${clean.slice(clean.length - EVIDENCE_MAX_CHARS + 1)}` : clean;
}

/** Short French description of what an approval asks for (redacted command). */
export function approvalSummary(approval: Approval): string {
  const { request } = approval;
  if (request.argv && request.argv.length > 0) return `exécuter ${redactSecrets(shortCommand(request.argv))}`;
  if (request.path !== undefined) {
    if (request.operation === "delete") return `supprimer ${request.path}`;
    if (request.operation === "write") return `modifier ${request.path}`;
    return `lire ${request.path}`;
  }
  if (request.host) return `accéder à ${request.host}`;
  return `utiliser l'outil ${request.tool}`;
}

/** A signal ready to record, with the identity of its fact (the same fact is recorded once). */
export interface ProducedSignal {
  draft: SignalDraft;
  key: string;
}

function refKey(ref: SignalDraft["sourceRef"]): string {
  switch (ref.kind) {
    case "tool_call":
      return `tool_call:${ref.toolCallId}`;
    case "terminal":
      return `terminal:${ref.sessionId}`;
    case "mission":
      return `mission:${ref.missionId}`;
    case "approval":
      return `approval:${ref.approvalId}`;
  }
}

function produced(draft: SignalDraft, occurrence: string | null = null): ProducedSignal {
  const key = `${draft.kind}:${refKey(draft.sourceRef)}`;
  return { draft, key: occurrence === null ? key : `${key}:${occurrence}` };
}

/** Signals justified by one mission event; `mission` is the facts AFTER the event. */
export function signalsFromMissionEvent(event: MissionEvent, mission: MissionFacts | null): ProducedSignal[] {
  const workspaceId = mission?.workspaceId ?? null;
  const missionRef = { kind: "mission" as const, missionId: event.missionId };
  switch (event.type) {
    case "tool.finished": {
      const display = event.display;
      const sourceRef = { kind: "tool_call" as const, toolCallId: event.callId, missionId: event.missionId };
      if (display.kind === "tests") {
        const failed = (display.failed ?? 0) > 0 || (display.exitCode !== null && display.exitCode !== 0);
        if (!failed) return [];
        const excerpt = NOMI_COPY.explain.tests(display.failed, display.passed);
        return [produced({ kind: "test_failed", workspaceId, sourceRef, evidence: { excerpt, path: null } })];
      }
      if (display.kind === "command" && display.exitCode !== null && display.exitCode !== 0) {
        const tests = parseTestCounts(display.outputTail);
        const kind = tests && tests.failed > 0 ? "test_failed" : "process_crashed";
        return [produced({ kind, workspaceId, sourceRef, evidence: { excerpt: evidenceExcerpt(display.outputTail), path: null } })];
      }
      return [];
    }
    case "approval.requested":
      return [
        produced({
          kind: "approval_pending",
          workspaceId,
          sourceRef: { kind: "approval", approvalId: event.approval.id, missionId: event.missionId },
          evidence: { excerpt: approvalSummary(event.approval), path: event.approval.request.path ?? null },
        }),
      ];
    case "mission.suspended": {
      if (event.reason === "user") return [];
      const budget = event.reason === "budget" || event.reason === "daily_budget";
      const excerpt = evidenceExcerpt(event.detail) ?? NOMI_COPY.suspendReason[event.reason];
      const kind = budget ? "budget_reached" : "mission_waiting";
      // A mission can be suspended, resumed and suspended again: each suspension is its own fact.
      return [produced({ kind, workspaceId, sourceRef: missionRef, evidence: { excerpt, path: null } }, event.id)];
    }
    case "mission.succeeded": {
      const excerpt = evidenceExcerpt(event.summary);
      return [produced({ kind: "mission_done", workspaceId, sourceRef: missionRef, evidence: { excerpt, path: null } })];
    }
    case "mission.failed": {
      const excerpt = evidenceExcerpt(event.detail) ?? NOMI_COPY.missionFailure[event.reason];
      return [produced({ kind: "mission_failed", workspaceId, sourceRef: missionRef, evidence: { excerpt, path: null } })];
    }
    default:
      return [];
  }
}

export interface TerminalExit extends ProcessExitFact {
  sessionId: string;
  workspaceId: string | null;
}

/** A watched terminal command that ended badly (`watchId` tells two commands of a shell apart). */
export function signalFromProcessExit(exit: TerminalExit, watchId: string): ProducedSignal | null {
  if (exit.exitCode === 0) return null;
  const tests = parseTestCounts(exit.outputTail);
  const draft: SignalDraft = {
    kind: tests && tests.failed > 0 ? "test_failed" : "process_crashed",
    workspaceId: exit.workspaceId,
    sourceRef: { kind: "terminal", sessionId: exit.sessionId },
    evidence: { excerpt: evidenceExcerpt(exit.outputTail), path: null },
  };
  return produced(draft, watchId);
}

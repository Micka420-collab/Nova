// Companion state derived only from real facts: network, provider connection, stream phase, outcome.
import type { ProviderConnectionView, StreamPhase } from "@nova/shared";
import type { NomiState } from "@nova/ui";
import { fr } from "../copy/fr";
import { formatRelative } from "../lib/format";

export type OutcomeKind = "success" | "error" | "stopped";

export interface LastOutcome {
  kind: OutcomeKind;
  at: number;
}

export interface NomiInput {
  online: boolean;
  /** `null` while the connection has not been read yet. */
  connection: ProviderConnectionView | null;
  activeStreamPhase: StreamPhase | null;
  lastOutcome: LastOutcome | null;
  /** Title of the conversation of `lastOutcome` when that conversation is not on screen. */
  outcomeElsewhere?: string | null;
  now: number;
}

export interface NomiView {
  state: NomiState;
  label: string;
  detail: string;
}

/** How long a finished generation keeps Nomi in its success/error/stopped pose. */
export const OUTCOME_WINDOW_MS = 4000;

function connectionDetail(connection: ProviderConnectionView, now: number): string {
  if (connection.state === "valid" && connection.lastCheckedAt !== null) {
    return fr.nomi.verified(formatRelative(connection.lastCheckedAt, now));
  }
  return connection.state === "error" ? fr.nomi.checkFailed : fr.nomi.unverified;
}

export function deriveNomiState({
  online,
  connection,
  activeStreamPhase,
  lastOutcome,
  outcomeElsewhere = null,
  now,
}: NomiInput): NomiView {
  if (connection === null) return { state: "offline", label: fr.nomi.starting, detail: fr.nomi.startingDetail };
  if (connection.state === "absent") return { state: "offline", label: fr.nomi.noKey, detail: fr.nomi.noKeyDetail };
  if (connection.state === "invalid") {
    return { state: "error", label: fr.nomi.invalidKey, detail: fr.nomi.invalidKeyDetail };
  }
  if (!online) return { state: "offline", label: fr.nomi.offline, detail: fr.nomi.offlineDetail };
  if (activeStreamPhase === "waiting") {
    return { state: "thinking", label: fr.nomi.thinking, detail: fr.nomi.waitingDetail };
  }
  if (activeStreamPhase === "reasoning") {
    return { state: "thinking", label: fr.nomi.thinking, detail: fr.nomi.reasoningDetail };
  }
  if (activeStreamPhase === "writing") return { state: "working", label: fr.nomi.working, detail: fr.nomi.writingDetail };
  const detail = connectionDetail(connection, now);
  const recent = lastOutcome !== null && now - lastOutcome.at >= 0 && now - lastOutcome.at < OUTCOME_WINDOW_MS;
  if (recent && lastOutcome.kind === "success") return { state: "success", label: fr.nomi.success, detail };
  if (recent && lastOutcome.kind === "error") {
    const errorDetail = outcomeElsewhere === null ? fr.nomi.errorDetail : fr.nomi.errorElsewhere(outcomeElsewhere);
    return { state: "error", label: fr.nomi.error, detail: errorDetail };
  }
  if (recent && lastOutcome.kind === "stopped") return { state: "idle", label: fr.nomi.stopped, detail };
  return { state: "idle", label: fr.nomi.idle, detail };
}

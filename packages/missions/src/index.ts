// @nova/missions — mission loop (A1/A9/A12/A13), run inside the `agent-runtime` utilityProcess.
//
// Contract for the feature implementation:
// - The runtime holds NO key and opens no socket: generations go through `ProviderProxy` (main adds
//   the key), tool calls through `ToolGateway` (main evaluates permission, then delegates).
// - Every state change is an appended MissionEvent (packages/shared/src/missions.ts); the store is
//   `mission_events` (storage repos/missions). Exactly one terminal event per mission; one
//   `tool.finished` per `tool.requested`; `mission.succeeded` only when every checkable acceptance
//   criterion was verified by a recorded proof (A4) — otherwise `failed` or "manual" left to the user.
// - Bounds: iterations, duration (contract.maxDurationMs), budget with reservation before each call
//   (D11: 0.50 $/mission, 5 $/day by default), no-progress detection (same call + same result ×3 →
//   suspend with reason `no_progress`).
// - Tools sent to the model are the mode's set in stable order (prompt cache); `tools` are resent on
//   every request (OpenRouter requirement).
import type {
  MissionContract,
  MissionEvent,
  Mission,
  MissionTask,
  ToolCall,
  ToolDefinition,
  ToolResult,
  UsageSummary,
} from "@nova/shared";

/** Provider access through main (the runtime never sees the API key). */
export interface ProviderProxy {
  stream(request: ProxyStreamRequest, signal: AbortSignal): AsyncIterable<ProxyStreamEvent>;
}

export interface ProxyStreamRequest {
  modelId: string;
  messages: ProxyMessage[];
  tools: ToolDefinition[];
  /** OpenRouter web plugin, only when the contract allows it (D3). */
  webSearch: boolean;
}

export type ProxyMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: { id: string; name: string; arguments: string }[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ProxyStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning" }
  | { type: "tool_call_delta"; index: number; id: string | null; name: string | null; argumentsDelta: string }
  | { type: "usage"; usage: UsageSummary }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" | "error" };

/** Tool execution through main: permission first, then the owning worker. */
export interface ToolGateway {
  run(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

/** Append-only event sink; returns the stored event (with its seq). Live-only events are not stored. */
export interface MissionEventSink {
  append(event: Omit<MissionEvent, "id" | "seq" | "at">): MissionEvent;
}

export interface MissionRuntime {
  start(mission: Mission, contract: MissionContract, tasks: MissionTask[]): Promise<void>;
  pause(missionId: string): void;
  resume(missionId: string): void;
  /** Idempotent. */
  stop(missionId: string): void;
  /** Resolves when no mission is running (used at quit). */
  idle(): Promise<void>;
}

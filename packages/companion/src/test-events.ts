// Test helpers: a recorded mission log built event by event (ids and seq like mission_events).
import type { Approval, MissionEvent, ToolDisplay, ToolName } from "@nova/shared";

type Payload<T extends MissionEvent["type"]> = Omit<Extract<MissionEvent, { type: T }>, "id" | "seq" | "at" | "missionId" | "type">;

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const MISSION_ID = "22222222-2222-4222-8222-222222222222";

export class MissionLog {
  readonly events: MissionEvent[] = [];
  private seq = 0;
  constructor(
    readonly missionId = MISSION_ID,
    public at = 1_000_000,
  ) {}

  add<T extends MissionEvent["type"]>(type: T, payload: Payload<T>): Extract<MissionEvent, { type: T }> {
    this.seq += 1;
    this.at += 1_000;
    const event = { id: `ev-${this.missionId}-${this.seq}`, seq: this.seq, at: this.at, missionId: this.missionId, type, ...payload };
    this.events.push(event as MissionEvent);
    return event as Extract<MissionEvent, { type: T }>;
  }

  created(title = "Facturation"): this {
    this.add("mission.created", {
      mission: {
        id: this.missionId,
        workspaceId: WORKSPACE_ID,
        conversationId: null,
        title,
        goal: "Corriger le total",
        mode: "fix",
        state: "ready",
        modelId: null,
        createdAt: this.at,
        startedAt: null,
        endedAt: null,
        updatedAt: this.at,
      },
      contract: {
        workspaceId: WORKSPACE_ID,
        mode: "fix",
        profile: "assisted",
        isolationLevel: "L0",
        allowedOperations: ["read", "write", "execute"],
        allowedHosts: [],
        webSearch: false,
        maxDurationMs: 900_000,
        budgetUsd: 4,
      },
    });
    return this;
  }

  started(): this {
    const created = this.events.find((event) => event.type === "mission.created");
    if (created?.type !== "mission.created") throw new Error("created first");
    this.add("mission.started", { contract: created.contract });
    return this;
  }

  tool(callId: string, name: ToolName): this {
    this.add("tool.requested", {
      call: { id: callId, name, operation: "read", argumentsPreview: "{}", path: null, host: null, argv: null },
      taskId: null,
    });
    this.add("tool.started", { callId, isolationLevel: null });
    return this;
  }

  finished(callId: string, display: ToolDisplay, state: "succeeded" | "failed" = "succeeded"): this {
    this.add("tool.finished", { callId, state, display, durationMs: 10 });
    return this;
  }
}

export function commandDisplay(argv: string[], exitCode: number | null, outputTail: string): ToolDisplay {
  return {
    kind: "command",
    argv,
    cwd: "",
    exitCode,
    signal: null,
    durationMs: 10,
    outputTail,
    outputArtifactId: null,
    isolationLevel: "L0",
  };
}

export function testsDisplay(passed: number | null, failed: number | null, exitCode: number | null): ToolDisplay {
  return { kind: "tests", runner: "vitest", passed, failed, skipped: 0, exitCode, proofId: null };
}

export function approval(id: string, argv: string[] | null = ["pnpm", "install"], missionId = MISSION_ID): Approval {
  return {
    id,
    request: {
      workspaceId: WORKSPACE_ID,
      missionId,
      ...(argv
        ? { tool: "run_command" as const, operation: "execute" as const, argv }
        : { tool: "edit_file" as const, operation: "write" as const, path: "db/schema.ts" }),
    },
    decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle de test." },
    toolCallId: null,
    status: "pending",
    scope: null,
    createdAt: 1,
    decidedAt: null,
  };
}

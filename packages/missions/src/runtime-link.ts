// The main ⇄ agent-runtime link over one port. Runtime side: a ProviderProxy, a ToolGateway and
// an event sink that all go through main. Main side: handlers that validate what the runtime sends
// (it runs model-driven code: it can ask, never decide) and the control calls to the runtime.
import type { ToolResult } from "@nova/shared";
import { errorResult, z } from "@nova/tools";
import { ChannelError, createChannel, type Channel, type PortLike } from "./channel";
import {
  ProxyError,
  type MissionEventInput,
  type MissionEventSink,
  type MissionRunSpec,
  type ProviderProxy,
  type ProxyErrorCode,
  type ProxyStreamEvent,
  type ProxyStreamRequest,
  type SystemPromptBuilder,
  type ToolGateway,
  type ToolRunRequest,
} from "./index";
import { MissionLoop, type LoopLimits } from "./loop";

// ---------------------------------------------------------------------------
// Runtime side

/** Pull-based view of the pushed `model.stream` events. */
export function createChannelProviderProxy(channel: Channel): ProviderProxy {
  return {
    stream(request, signal) {
      return {
        [Symbol.asyncIterator]() {
          const queue: ProxyStreamEvent[] = [];
          let done = false;
          let failure: Error | null = null;
          let wake: (() => void) | null = null;
          const notify = (): void => {
            wake?.();
            wake = null;
          };
          channel
            .request("model.stream", request, {
              signal,
              onStream: (event) => {
                queue.push(event as ProxyStreamEvent);
                notify();
              },
            })
            .then(
              () => {
                done = true;
                notify();
              },
              (error: unknown) => {
                const code = error instanceof ChannelError ? error.code : "unknown";
                const retryable = error instanceof ChannelError && error.retryable;
                failure = new ProxyError(code as ProxyErrorCode, error instanceof Error ? error.message : "stream failed", retryable);
                done = true;
                notify();
              },
            );
          return {
            async next(): Promise<IteratorResult<ProxyStreamEvent>> {
              for (;;) {
                const event = queue.shift();
                if (event) return { value: event, done: false };
                if (failure) throw failure;
                if (done) return { value: undefined, done: true };
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
            },
          };
        },
      };
    },
  };
}

export function createChannelToolGateway(channel: Channel): ToolGateway {
  return {
    async run(request, signal) {
      try {
        return await channel.request<ToolResult>("tool.run", request, { signal });
      } catch {
        return signal.aborted
          ? errorResult(request.id, "cancelled", "stopped by the user")
          : errorResult(request.id, "unavailable", "the tool service is unavailable");
      }
    },
  };
}

/**
 * Serves the runtime end of the port: control from main (`mission.*`), model and tool calls to
 * main, events to main. Returns the loop (for `idle()` at quit).
 */
export function serveRuntimeChannel(
  port: PortLike,
  options: { systemPrompt: SystemPromptBuilder; limits?: Partial<LoopLimits> },
): { loop: MissionLoop; channel: Channel } {
  let loop: MissionLoop | null = null;
  const missionIdOf = (params: unknown): string => {
    const id = (params as { missionId?: unknown } | null)?.missionId;
    if (typeof id !== "string") throw new ChannelError("invalid_request", "missionId required");
    return id;
  };
  const channel = createChannel(port, {
    "mission.start": (params) => {
      const spec = params as MissionRunSpec;
      if (typeof spec?.mission?.id !== "string") throw new ChannelError("invalid_request", "invalid mission spec");
      void loop?.start(spec);
      return { accepted: true };
    },
    "mission.pause": (params) => loop?.pause(missionIdOf(params)),
    "mission.resume": (params) => loop?.resume(missionIdOf(params)),
    "mission.stop": (params) => loop?.stop(missionIdOf(params)),
    "runtime.idle": () => loop?.idle(),
  });
  const sink: MissionEventSink = { append: (event) => channel.notify("event.append", event) };
  loop = new MissionLoop({
    proxy: createChannelProviderProxy(channel),
    gateway: createChannelToolGateway(channel),
    sink,
    systemPrompt: options.systemPrompt,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { loop, channel };
}

// ---------------------------------------------------------------------------
// Main side

/** Control of the runtime, as seen by the controller. */
export interface RuntimeLink {
  start(spec: MissionRunSpec): Promise<void>;
  pause(missionId: string): void;
  resume(missionId: string): void;
  stop(missionId: string): void;
  /** Resolves when the runtime is gone (crash or quit): main fails its running missions. */
  readonly closed: Promise<void>;
}

/** Events the runtime may append; everything else is produced by main itself. */
const RUNTIME_EVENT_TYPES = new Set<string>([
  "task.updated",
  "message.delta",
  "message.completed",
  "mission.suspended",
  "mission.resumed",
  "mission.succeeded",
  "mission.failed",
  "mission.cancelled",
]);

const ToolRunSchema = z.object({
  id: z.uuid(),
  providerCallId: z.string().max(200).nullable(),
  missionId: z.uuid(),
  name: z.string().min(1).max(200),
  rawArguments: z.string().max(2_000_000),
  requestedAt: z.number(),
});

const ProxyRequestSchema = z.object({
  missionId: z.uuid(),
  modelId: z.string().min(1).max(200),
  messages: z.array(z.record(z.string(), z.unknown())).max(2_000),
  tools: z.array(z.record(z.string(), z.unknown())).max(512),
  webSearch: z.boolean(),
  maxTokens: z.int().min(1).max(200_000),
  purpose: z.enum(["plan", "step"]),
});

export interface MainRuntimeHandlers {
  /** Streams one generation for the runtime; throws ProxyError-like `{ code }` errors. */
  streamModel(request: ProxyStreamRequest, signal: AbortSignal, emit: (event: ProxyStreamEvent) => void): Promise<void>;
  gateway: ToolGateway;
  appendEvent(event: MissionEventInput): void;
  /** Only missions main started in the runtime may act. */
  isRunning(missionId: string): boolean;
}

export function connectRuntime(port: PortLike, handlers: MainRuntimeHandlers): RuntimeLink {
  const channel = createChannel(
    port,
    {
      "model.stream": async (params, context) => {
        const parsed = ProxyRequestSchema.safeParse(params);
        if (!parsed.success) throw new ChannelError("invalid_request", "invalid model request");
        if (!handlers.isRunning(parsed.data.missionId)) throw new ChannelError("invalid_request", "mission not running");
        await handlers.streamModel(parsed.data as unknown as ProxyStreamRequest, context.signal, (event) => context.stream(event));
      },
      "tool.run": async (params, context) => {
        const parsed = ToolRunSchema.safeParse(params);
        if (!parsed.success) throw new ChannelError("invalid_request", "invalid tool request");
        const request: ToolRunRequest = parsed.data;
        if (!handlers.isRunning(request.missionId)) throw new ChannelError("invalid_request", "mission not running");
        return handlers.gateway.run(request, context.signal);
      },
    },
    {
      "event.append": (params) => {
        const event = params as MissionEventInput | null;
        if (!event || typeof event.type !== "string" || !RUNTIME_EVENT_TYPES.has(event.type)) return;
        if (typeof event.missionId !== "string" || !handlers.isRunning(event.missionId)) return;
        handlers.appendEvent(event);
      },
    },
  );
  return {
    async start(spec) {
      await channel.request("mission.start", spec);
    },
    pause: (missionId) => void channel.request("mission.pause", { missionId }).catch(() => undefined),
    resume: (missionId) => void channel.request("mission.resume", { missionId }).catch(() => undefined),
    stop: (missionId) => void channel.request("mission.stop", { missionId }).catch(() => undefined),
    closed: channel.closed,
  };
}

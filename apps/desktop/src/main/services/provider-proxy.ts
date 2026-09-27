// Provider proxy (A1): the agent runtime holds no key, so every mission generation is performed
// here. Per call: key resolved in main → tool support checked against the catalog → cost
// estimated from catalog prices and RESERVED on the mission budget (refusal = `budget`) →
// OpenRouter stream with tools (resent every request), reasoning details kept for tool
// round-trips → events forwarded → reservation settled with the reported cost.
import type { RuntimeLogger } from "@nova/agent-runtime";
import { estimateCallCost, ProxyError, type MissionController, type ProviderProxy, type ProxyStreamEvent, type ProxyStreamRequest } from "@nova/missions";
import { ProviderError, type ChatMessageInput, type ModelProvider } from "@nova/providers";
import type { ModelInfo, UsageSummary } from "@nova/shared";

export interface ProviderProxyDeps {
  provider: Pick<ModelProvider, "streamChat">;
  /** Throws or returns null when no usable key exists. */
  resolveApiKey(): Promise<string | null>;
  dataCollection(): "deny" | "allow";
  /** Catalog entry (prices, capabilities); null = unknown model. */
  model(modelId: string): ModelInfo | null;
  budget: MissionController["budget"];
  /**
   * Mo2: fallback models for a primary, chosen by the routing profile (never a more expensive or
   * less private model: the profile guarantees it). Default: none.
   */
  fallbackModelIds?(modelId: string): string[];
  logger?: RuntimeLogger;
}

export interface ProviderProxyHost {
  /** Streams one generation for a mission (runtime link handler). Throws ProxyError. */
  streamModel(request: ProxyStreamRequest, signal: AbortSignal, emit: (event: ProxyStreamEvent) => void): Promise<void>;
  /** Same path as an in-process ProviderProxy (planner in main). */
  proxy: ProviderProxy;
}

const FINISH_REASONS = new Set(["stop", "tool_calls", "length", "content_filter", "error"]);

function toChatMessages(request: ProxyStreamRequest): ChatMessageInput[] {
  return request.messages.map((message): ChatMessageInput => {
    switch (message.role) {
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls.length > 0 ? { toolCalls: message.toolCalls } : {}),
          ...(message.reasoningDetails && message.reasoningDetails.length > 0 ? { reasoningDetails: message.reasoningDetails } : {}),
        };
      case "tool":
        return { role: "tool", toolCallId: message.toolCallId, content: message.content };
      default:
        return { role: message.role, content: message.content };
    }
  });
}

export function createProviderProxyHost(deps: ProviderProxyDeps): ProviderProxyHost {
  async function streamModel(request: ProxyStreamRequest, signal: AbortSignal, emit: (event: ProxyStreamEvent) => void): Promise<void> {
    let apiKey: string | null;
    try {
      apiKey = await deps.resolveApiKey();
    } catch {
      throw new ProxyError("key_unreadable", "the stored key cannot be read");
    }
    if (!apiKey) throw new ProxyError("no_key", "no OpenRouter key");
    const info = deps.model(request.modelId);
    if (request.tools.length > 0 && info?.supportsTools === false) {
      throw new ProxyError("no_tool_support", "this model does not support tool calling");
    }

    const estimate = estimateCallCost({
      messages: request.messages,
      tools: request.tools,
      maxTokens: request.maxTokens,
      pricing: info?.pricing ?? null,
    });
    const reservation = deps.budget.reserve(request.missionId, estimate.maxUsd);
    if (!reservation.ok) throw new ProxyError(reservation.code, reservation.message);

    let received = false;
    let usage: UsageSummary | null = null;
    let servedModel: string | null = null;
    let servedProvider: string | null = null;
    const settle = (failed: boolean): void => {
      // Nothing received: the call never reached a model, nothing was billed.
      if (failed && !received) {
        deps.budget.release(request.missionId, reservation.reservationId);
        return;
      }
      deps.budget.settle(request.missionId, reservation.reservationId, { modelId: request.modelId, servedModel, servedProvider, usage });
    };

    try {
      const fallbacks = deps.fallbackModelIds?.(request.modelId) ?? [];
      const stream = deps.provider.streamChat(apiKey, {
        modelId: request.modelId,
        messages: toChatMessages(request),
        signal,
        dataCollection: deps.dataCollection(),
        maxTokens: request.maxTokens,
        keepReasoningDetails: true,
        ...(request.tools.length > 0
          ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: { ...tool.inputSchema } })) }
          : {}),
        ...(request.webSearch ? { webPlugin: { maxResults: 5 } } : {}),
        ...(fallbacks.length > 0 ? { fallbackModelIds: fallbacks } : {}),
      });
      for await (const event of stream) {
        received = true;
        switch (event.type) {
          case "meta":
            servedModel = event.servedModel;
            servedProvider = event.servedProvider;
            emit({ type: "meta", servedModel: event.servedModel, servedProvider: event.servedProvider });
            break;
          case "usage":
            usage = event.usage;
            emit(event);
            break;
          case "finish": {
            const reason = event.finishReason ?? "unknown";
            emit({ type: "finish", reason: FINISH_REASONS.has(reason) ? (reason as "stop") : "unknown" });
            break;
          }
          default:
            emit(event);
        }
      }
      settle(false);
    } catch (error) {
      settle(true);
      if (error instanceof ProviderError) throw new ProxyError(error.info.code, error.message, error.info.retryable);
      if (signal.aborted) throw new ProxyError("aborted", "request aborted");
      deps.logger?.warn("provider proxy failed", { missionId: request.missionId });
      throw new ProxyError("unknown", "generation failed");
    }
  }

  return {
    streamModel,
    proxy: {
      async *stream(request, signal) {
        // Push → pull: events are buffered and yielded in order; errors surface after them.
        const queue: ProxyStreamEvent[] = [];
        let wake: (() => void) | null = null;
        let finished = false;
        let failure: unknown = null;
        void streamModel(request, signal, (event) => {
          queue.push(event);
          wake?.();
        }).then(
          () => {
            finished = true;
            wake?.();
          },
          (error: unknown) => {
            failure = error;
            finished = true;
            wake?.();
          },
        );
        for (;;) {
          const event = queue.shift();
          if (event) {
            yield event;
            continue;
          }
          if (finished) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
    },
  };
}

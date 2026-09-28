// C5 v1: what a model call sends, as an inspectable list with approximate token counts.
// Estimation is deliberately simple (≈ 4 characters per token) and always shown as "≈".
import type { ToolDefinition } from "@nova/shared";
import type { ProxyMessage } from "./index";

export const CHARS_PER_TOKEN = 4;

export interface ContextPlanItem {
  kind: "system" | "user" | "assistant" | "tool_result" | "tools";
  label: string;
  chars: number;
  approxTokens: number;
}

export interface ContextPlan {
  items: ContextPlanItem[];
  approxPromptTokens: number;
  toolCount: number;
  destination: { provider: "openrouter"; modelId: string; dataCollection: "deny" | "allow" };
}

const approx = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

export function buildContextPlan(input: {
  messages: readonly ProxyMessage[];
  tools: readonly ToolDefinition[];
  modelId: string;
  dataCollection: "deny" | "allow";
}): ContextPlan {
  const items: ContextPlanItem[] = input.messages.map((message, index) => {
    const chars =
      message.role === "assistant"
        ? message.content.length + message.toolCalls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0)
        : message.content.length;
    const kind = message.role === "tool" ? "tool_result" : message.role;
    const label = message.role === "assistant" && message.toolCalls.length > 0 ? `assistant (${message.toolCalls.length} tool calls)` : `${kind} #${index}`;
    return { kind, label, chars, approxTokens: approx(chars) };
  });
  if (input.tools.length > 0) {
    const chars = JSON.stringify(input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }))).length;
    items.push({ kind: "tools", label: `${input.tools.length} tools`, chars, approxTokens: approx(chars) });
  }
  return {
    items,
    approxPromptTokens: items.reduce((sum, item) => sum + item.approxTokens, 0),
    toolCount: input.tools.length,
    destination: { provider: "openrouter", modelId: input.modelId, dataCollection: input.dataCollection },
  };
}

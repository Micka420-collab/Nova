// A1: "no progress" = the same call (tool + arguments) returning the same result three times.
import type { ToolResult } from "@nova/shared";

export const NO_PROGRESS_REPEATS = 3;

const NO_KEYS: ReadonlySet<string> = new Set();
/** Fields that differ on every run of the same call (timings, generated ids). */
const VOLATILE_KEYS: ReadonlySet<string> = new Set(["durationMs", "proofId", "checkpointId", "outputArtifactId", "mtimeMs", "costUsd"]);

/** Canonical JSON (sorted keys) so `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same call. */
function canonical(value: unknown, skip: ReadonlySet<string> = NO_KEYS): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, skip)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !skip.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, skip)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function callKey(name: string, rawArguments: string): string {
  try {
    return `${name}:${canonical(JSON.parse(rawArguments || "{}"))}`;
  } catch {
    return `${name}:${rawArguments.trim()}`;
  }
}

/** Result identity ignores the random provenance fence: the structured display is compared. */
function resultKey(result: ToolResult): string {
  return `${String(result.ok)}:${canonical(result.display, VOLATILE_KEYS)}`;
}

export class NoProgressDetector {
  private readonly counts = new Map<string, number>();

  /** Records a call; returns true when this exact call/result pair reached the repeat limit. */
  record(name: string, rawArguments: string, result: ToolResult): boolean {
    const key = `${callKey(name, rawArguments)}→${resultKey(result)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count >= NO_PROGRESS_REPEATS;
  }

  reset(): void {
    this.counts.clear();
  }
}

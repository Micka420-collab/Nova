import { describe, expect, it } from "vitest";
import { scriptedStream, splitBytes, type StreamStep } from "./__fixtures__/fake-fetch";
import { readSse, type SseItem } from "./sse";

async function collect(steps: StreamStep[]): Promise<SseItem[]> {
  const items: SseItem[] = [];
  for await (const item of readSse(scriptedStream(steps).stream)) items.push(item);
  return items;
}

const TRANSCRIPT = [
  ": OPENROUTER PROCESSING",
  "",
  'data: {"text":"Élan 🚀 café"}',
  "",
  ": OPENROUTER PROCESSING",
  "",
  'data: {"text":"日本語"}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const EXPECTED: SseItem[] = [
  { kind: "comment", text: "OPENROUTER PROCESSING" },
  { kind: "data", data: '{"text":"Élan 🚀 café"}' },
  { kind: "comment", text: "OPENROUTER PROCESSING" },
  { kind: "data", data: '{"text":"日本語"}' },
  { kind: "data", data: "[DONE]" },
];

describe("readSse", () => {
  it.each([1, 2, 3, 5, 7, 1024])("decodes the same items when bytes arrive %i at a time", async (size) => {
    expect(await collect(splitBytes(TRANSCRIPT, size))).toEqual(EXPECTED);
  });

  it.each([1, 3, 1024])("handles CRLF line endings split every %i bytes", async (size) => {
    expect(await collect(splitBytes(TRANSCRIPT.replaceAll("\n", "\r\n"), size))).toEqual(EXPECTED);
  });

  it("keeps a CRLF split between chunks as one terminator, not an event boundary", async () => {
    expect(await collect(["da", 'ta: {"a":', "1}\r", "\nda", "ta: x\r", "\n\r", "\n"])).toEqual([
      { kind: "data", data: '{"a":1}\nx' },
    ]);
  });

  it("drops an event that the stream never terminated with a blank line", async () => {
    expect(await collect(['data: {"a":1}\n\n', 'data: {"b":2}'])).toEqual([{ kind: "data", data: '{"a":1}' }]);
  });

  it("reports activity for every received chunk, keep-alive comments included", async () => {
    let chunks = 0;
    const steps = [": OPENROUTER PROCESSING\n\n", ": OPENROUTER PROCESSING\n\n", "data: [DONE]\n\n"];
    for await (const item of readSse(scriptedStream(steps).stream, { onBytes: () => chunks++ })) void item;
    expect(chunks).toBe(3);
  });

  it("cancels the stream when the consumer stops early", async () => {
    const source = scriptedStream(["data: 1\n\n", "data: 2\n\n"], { hang: true });
    for await (const item of readSse(source.stream)) {
      expect(item).toEqual({ kind: "data", data: "1" });
      break;
    }
    expect(source.cancelled).toBe(true);
  });

  it("throws the abort reason and cancels the stream when the signal aborts mid-read", async () => {
    const source = scriptedStream(["data: 1\n\n"], { hang: true });
    const controller = new AbortController();
    const items: SseItem[] = [];
    const reading = (async () => {
      for await (const item of readSse(source.stream, { signal: controller.signal })) {
        items.push(item);
        setTimeout(() => controller.abort(), 5);
      }
    })();
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(items).toEqual([{ kind: "data", data: "1" }]);
    expect(source.cancelled).toBe(true);
  });
});

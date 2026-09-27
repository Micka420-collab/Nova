import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileLogger } from "./logger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-log-"));
  dirs.push(dir);
  return join(dir, "logs");
}

describe("createFileLogger", () => {
  it("writes structured JSON lines with secrets redacted", () => {
    const dir = tempDir();
    const logger = createFileLogger({ dir, now: () => Date.UTC(2026, 8, 27) });
    logger.warn("key check failed for sk-or-v1-abcdefghijklmnop", {
      header: "Authorization: Bearer abcdefghijklmnop.qrs",
      error: new Error("boom sk-or-v1-zzzzzzzzzzzzzzzz"),
    });

    const lines = readFileSync(logger.file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as { time: string; level: string; msg: string; data: unknown };
    expect(entry).toMatchObject({ time: "2026-09-27T00:00:00.000Z", level: "warn" });
    expect(entry.msg).toBe("key check failed for [secret masqué]");
    const raw = lines[0] ?? "";
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).not.toContain("zzzzzzzz");
    expect(raw).toContain("boom [secret masqué]");
  });

  it("rotates by size and keeps a bounded number of files", () => {
    const dir = tempDir();
    const logger = createFileLogger({ dir, maxBytes: 200, maxFiles: 3 });
    for (let index = 0; index < 20; index += 1) logger.info(`event ${index}`, { padding: "x".repeat(60) });

    expect(existsSync(`${logger.file}.1`)).toBe(true);
    expect(existsSync(`${logger.file}.2`)).toBe(true);
    expect(existsSync(`${logger.file}.3`)).toBe(false);
    for (const file of [logger.file, `${logger.file}.1`, `${logger.file}.2`]) {
      expect(readFileSync(file).length).toBeLessThanOrEqual(200);
    }
    expect(readFileSync(logger.file, "utf8")).toContain("event 19");
  });
});

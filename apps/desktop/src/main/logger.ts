// Structured JSON-lines logger of the main process. Every line goes through redactSecrets.
// Callers never pass message contents or keys; redaction is the safety net, not the policy.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeLogger } from "@nova/agent-runtime";
import { redactSecrets } from "@nova/shared";

export type LogLevel = "info" | "warn" | "error";

export interface Logger extends RuntimeLogger {
  /** Absolute path of the current log file. */
  readonly file: string;
}

export interface FileLoggerOptions {
  dir: string;
  fileName?: string;
  /** Size that triggers a rotation. */
  maxBytes?: number;
  /** Files kept, current one included (`nova.log`, `nova.log.1`, …). */
  maxFiles?: number;
  /** Also write each line to stdout/stderr (development). */
  mirrorToConsole?: boolean;
  now?: () => number;
}

function serializable(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function formatLine(time: number, level: LogLevel, msg: string, data: Record<string, unknown> | undefined): string {
  const entry = { time: new Date(time).toISOString(), level, msg, ...(data ? { data } : {}) };
  let json: string;
  try {
    json = JSON.stringify(entry, serializable);
  } catch {
    json = JSON.stringify({ time: entry.time, level, msg, data: "[unserializable]" });
  }
  return `${redactSecrets(json)}\n`;
}

export function createFileLogger(options: FileLoggerOptions): Logger {
  const { dir, maxBytes = 1_000_000, maxFiles = 3, mirrorToConsole = false, now = Date.now } = options;
  const file = join(dir, options.fileName ?? "nova.log");
  let size = 0;
  let broken = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    size = statSync(file).size;
  } catch {
    size = 0;
  }

  const rotate = (): void => {
    rmSync(`${file}.${maxFiles - 1}`, { force: true });
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      try {
        renameSync(`${file}.${index}`, `${file}.${index + 1}`);
      } catch {
        // Missing older file: nothing to shift.
      }
    }
    renameSync(file, `${file}.1`);
    size = 0;
  };

  const write = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    const line = formatLine(now(), level, msg, data);
    if (mirrorToConsole) (level === "info" ? process.stdout : process.stderr).write(line);
    try {
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, line, { mode: 0o600 });
      size += bytes;
      broken = false;
    } catch (error) {
      // Logging must never break the app; report the first failure of a streak only.
      if (!broken) console.error("NOVA log write failed", redactSecrets(String(error)));
      broken = true;
    }
  };

  return {
    file,
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
  };
}

/** Error to a loggable string: stack when present, secrets redacted by the logger. */
export function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
}

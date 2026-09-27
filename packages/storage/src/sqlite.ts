// Small typed helpers over node:sqlite (synchronous API, rows are null-prototype records).
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export type Row = Record<string, SQLOutputValue>;

/** Runs `fn` inside BEGIN IMMEDIATE/COMMIT; rolls back and rethrows on failure. Not reentrant. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function columnError(column: string, expected: string, value: unknown): Error {
  return new Error(`Column "${column}": expected ${expected}, got ${typeof value}`);
}

export function readText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw columnError(column, "text", value);
  return value;
}

export function readTextOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw columnError(column, "text", value);
  return value;
}

export function readNumber(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number") throw columnError(column, "number", value);
  return value;
}

export function readNumberOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") throw columnError(column, "number", value);
  return value;
}

export function readBlob(row: Row, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) throw columnError(column, "blob", value);
  return value;
}

/** JSON columns are only written by this package from typed values, so the shape is trusted. */
export function readJsonOrNull<T>(row: Row, column: string): T | null {
  const text = readTextOrNull(row, column);
  return text === null ? null : (JSON.parse(text) as T);
}

export function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnsupportedSchemaError, openNovaStore } from "@nova/storage";
import { afterEach, describe, expect, it } from "vitest";
import { classifyStoreOpenFailure, corruptDatabaseMessage, quarantineDatabase } from "./store-recovery";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-recovery-"));
  dirs.push(dir);
  return dir;
}

function openFailure(path: string): unknown {
  try {
    openNovaStore(path).close();
  } catch (error) {
    return error;
  }
  throw new Error("expected the store to fail opening");
}

describe("classifyStoreOpenFailure", () => {
  it("recognizes a file that is not a database", () => {
    const path = join(tempDir(), "nova.sqlite");
    writeFileSync(path, "pas une base".repeat(400));
    expect(classifyStoreOpenFailure(openFailure(path))).toBe("corrupt");
  });

  it("recognizes damage beyond the first page with the integrity check", () => {
    const path = join(tempDir(), "nova.sqlite");
    const store = openNovaStore(path);
    const { id } = store.createConversation({ title: "t", modelId: null });
    for (let index = 0; index < 400; index += 1) {
      const content = `m${index} ${"x".repeat(60)}`;
      store.insertMessage({ conversationId: id, role: "user", content, status: "complete", modelId: null });
    }
    store.close();
    const bytes = readFileSync(path);
    const pageSize = 4096;
    // A page in the middle of the messages table: page 1 (the header) stays intact.
    const page = Math.floor(bytes.length / pageSize / 2);
    bytes.fill(0x41, page * pageSize, page * pageSize + 2000);
    writeFileSync(path, bytes);
    expect(classifyStoreOpenFailure(openFailure(path))).toBe("corrupt");
  });

  it("keeps the newer-schema refusal and other failures apart", () => {
    const path = join(tempDir(), "nova.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 999");
    db.close();
    const newer = openFailure(path);
    expect(newer).toBeInstanceOf(UnsupportedSchemaError);
    expect(classifyStoreOpenFailure(newer)).toBe("newer_schema");
    expect(classifyStoreOpenFailure(new Error("EACCES: permission denied"))).toBe("other");
  });
});

describe("quarantineDatabase", () => {
  it("moves the database with its journal files aside, so a fresh one can be created", () => {
    const dir = tempDir();
    const path = join(dir, "nova.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${path}${suffix}`, `contenu${suffix}`);
    writeFileSync(join(dir, "nova.log"), "journal");

    const moved = quarantineDatabase(path, new Date("2026-09-27T10:55:21.123Z"));
    const base = `${path}.corrupt-2026-09-27T10-55-21-123Z`;
    expect(moved).toEqual([base, `${base}-wal`, `${base}-shm`]);
    expect(readFileSync(`${base}-wal`, "utf8")).toBe("contenu-wal");
    const quarantined = "nova.sqlite.corrupt-2026-09-27T10-55-21-123Z";
    expect(readdirSync(dir).sort()).toEqual(
      ["nova.log", quarantined, `${quarantined}-shm`, `${quarantined}-wal`].sort(),
    );
    const reopened = openNovaStore(path);
    expect(reopened.listConversations().items).toEqual([]);
    reopened.close();
  });

  it("moves only the files that exist", () => {
    const path = join(tempDir(), "nova.sqlite");
    writeFileSync(path, "x");
    expect(quarantineDatabase(path, new Date(0))).toEqual([`${path}.corrupt-1970-01-01T00-00-00-000Z`]);
  });
});

describe("corruptDatabaseMessage", () => {
  it("names the database file", () => {
    expect(corruptDatabaseMessage("/data/nova.sqlite").detail).toContain("/data/nova.sqlite");
  });
});

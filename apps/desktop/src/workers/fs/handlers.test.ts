import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsHandlers, type FsHandlers } from "./handlers";

const WORKSPACE = "5b0c9a3e-2f1d-4c6b-8a7e-9d0f1e2a3b4c";
const posix = process.platform !== "win32";

let dir: string;
let handlers: FsHandlers | null = null;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "nova-fs-handlers-")));
});

afterEach(async () => {
  await handlers?.dispose();
  handlers = null;
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A "ripgrep" that records its pid and never answers: only a kill ends it. */
async function stuckRipgrep(): Promise<{ path: string; pids: () => Promise<number[]> }> {
  const path = join(dir, "rg-stuck.sh");
  const pidFile = join(dir, "pids");
  await writeFile(path, `#!/bin/sh\necho $$ >> "${pidFile}"\nexec sleep 30\n`);
  await chmod(path, 0o755);
  return {
    path,
    pids: async () => (await readFile(pidFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number),
  };
}

async function open(options: { rgPath: string; searchDeadlineMs?: number }): Promise<FsHandlers> {
  const root = join(dir, "project");
  await rm(root, { recursive: true, force: true });
  await mkdir(root);
  handlers = createFsHandlers({ notify: () => {}, watch: { debounceMs: 30 }, ...options });
  expect(await handlers["workspace.open"]({ workspaceId: WORKSPACE, root })).toMatchObject({ ok: true });
  return handlers;
}

const query = (pattern: string) => ({ workspaceId: WORKSPACE, pattern, isRegex: false, caseSensitive: false, wholeWord: false, include: [], exclude: [], maxResults: 100 });

describe.skipIf(!posix)("fs-worker text search", () => {
  it("a new one-shot search of a workspace kills the ripgrep of the previous one", async () => {
    const rg = await stuckRipgrep();
    const fs = await open({ rgPath: rg.path });
    const first = fs["search.text"](query("a"));
    await vi.waitFor(async () => expect(await rg.pids()).toHaveLength(1));
    const second = fs["search.text"](query("ab"));
    expect(await first).toMatchObject({ ok: false });
    await vi.waitFor(async () => expect(await rg.pids()).toHaveLength(2));
    const [firstPid] = await rg.pids();
    await vi.waitFor(() => expect(alive(firstPid as number)).toBe(false));
    await fs["search.cancel"]({ streamId: `text:${WORKSPACE}` });
    await second;
  });

  it("kills ripgrep past its deadline and says why", async () => {
    const rg = await stuckRipgrep();
    const fs = await open({ rgPath: rg.path, searchDeadlineMs: 200 });
    const outcome = await fs["search.text"](query("a"));
    expect(outcome).toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining("too long") });
    const [pid] = await rg.pids();
    await vi.waitFor(() => expect(alive(pid as number)).toBe(false));
  });
});

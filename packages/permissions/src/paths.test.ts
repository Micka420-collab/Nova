import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectIsolation } from "./isolation";
import { resolveInWorkspace } from "./paths";

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  // realpath: macOS tmpdir is a symlink (/var → /private/var); resolved paths are canonical.
  base = realpathSync(mkdtempSync(join(tmpdir(), "nova-perm-")));
  root = join(base, "project");
  outside = join(base, "secret");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src", "cart.ts"), "export {};");
  writeFileSync(join(outside, "id_rsa"), "key");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(root, "src"), join(root, "inner"));
  symlinkSync(join(outside, "missing-target"), join(root, "dangling"));
  symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
  symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveInWorkspace (S2)", () => {
  it("resolves existing files and the root", async () => {
    expect(await resolveInWorkspace(root, "src/cart.ts")).toEqual({
      ok: true,
      absolutePath: join(root, "src", "cart.ts"),
      relativePath: "src/cart.ts",
      exists: true,
    });
    expect(await resolveInWorkspace(root, "")).toMatchObject({ ok: true, relativePath: "" });
  });

  it("resolves a file that does not exist yet through its parent", async () => {
    expect(await resolveInWorkspace(root, "src/new/deep.ts")).toMatchObject({
      ok: true,
      relativePath: "src/new/deep.ts",
      exists: false,
    });
  });

  it("normalizes .. that stays inside and follows inner symlinks to their real path", async () => {
    expect(await resolveInWorkspace(root, "src/../src/cart.ts")).toMatchObject({ ok: true, relativePath: "src/cart.ts" });
    expect(await resolveInWorkspace(root, "inner/cart.ts")).toMatchObject({ ok: true, relativePath: "src/cart.ts" });
    expect(await resolveInWorkspace(root, join(root, "src", "cart.ts"))).toMatchObject({ ok: true, relativePath: "src/cart.ts" });
  });

  it.each([
    ["../secret/id_rsa"],
    ["src/../../secret/id_rsa"],
    ["/etc/passwd"],
    ["escape/id_rsa"],
    ["escape/new-file.txt"],
    ["dangling"],
    ["dangling/child.txt"],
  ])("refuses %s as outside the workspace", async (input) => {
    expect(await resolveInWorkspace(root, input)).toEqual({ ok: false, reason: "outside_workspace" });
  });

  it("refuses NUL bytes, symlink loops and a relative root as invalid", async () => {
    expect(await resolveInWorkspace(root, "src/a\0.ts")).toEqual({ ok: false, reason: "invalid_path" });
    expect(await resolveInWorkspace(root, "loop-a/x")).toEqual({ ok: false, reason: "invalid_path" });
    expect(await resolveInWorkspace("project", "src")).toEqual({ ok: false, reason: "invalid_path" });
  });

  it("refuses a sibling folder sharing the root's name prefix", async () => {
    mkdirSync(`${root}-other`, { recursive: true });
    expect(await resolveInWorkspace(root, `${root}-other/x`)).toEqual({ ok: false, reason: "outside_workspace" });
  });
});

describe("detectIsolation (S3)", () => {
  it("always reports L0 and only lists bubblewrap as a Linux candidate", async () => {
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bwrap"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await detectIsolation({ platform: "linux", pathEnv: bin })).toMatchObject({
      level: "L0",
      candidates: [{ level: "L1", tool: "bubblewrap", path: join(bin, "bwrap") }],
    });
    expect((await detectIsolation({ platform: "linux", pathEnv: "" })).candidates).toEqual([
      { level: "L1", tool: "bubblewrap", path: null },
    ]);
    expect((await detectIsolation({ platform: "win32", pathEnv: bin })).candidates).toEqual([]);
  });
});

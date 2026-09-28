import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILE_EDIT_MAX_BYTES } from "@nova/shared";
import { canonicalRoot, resolveExisting, resolveWriteTarget } from "./confine";
import { createEntry, listDirectory, moveEntry, readWorkspaceFile, writeWorkspaceFile } from "./files";
import { sha256 } from "./hash";
import { createIgnoreMatcher } from "./ignore-rules";
import { makeTempDir, type TempDir } from "./test-support";

let workspace: TempDir;
let outside: TempDir;
let root: string;

beforeEach(async () => {
  workspace = await makeTempDir();
  outside = await makeTempDir("nova-outside-");
  root = await canonicalRoot(workspace.path);
});
afterEach(async () => {
  await workspace.cleanup();
  await outside.cleanup();
});

describe("confinement (S2)", () => {
  it("refuses non-canonical paths instead of normalizing them", async () => {
    await expect(resolveExisting(root, "../etc/passwd")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(resolveExisting(root, "a/./b")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(resolveExisting(root, "/etc/passwd")).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("refuses symlinks escaping the root for reads, lists and writes, but follows inside ones", async () => {
    const secret = await outside.write("secret.txt", "top secret");
    await mkdir(join(root, "src"));
    await workspace.write("src/real.ts", "export {};\n");
    await symlink(secret, join(root, "leak.txt"));
    await symlink(outside.path, join(root, "outdir"));
    await symlink(join(root, "src", "real.ts"), join(root, "alias.ts"));
    await symlink(join(outside.path, "missing.txt"), join(root, "dangling.txt"));

    await expect(readWorkspaceFile(root, "leak.txt")).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(readWorkspaceFile(root, "outdir/secret.txt")).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(listDirectory(root, createIgnoreMatcher(root), "outdir")).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(writeWorkspaceFile(root, "leak.txt", "pwned", sha256("top secret"))).rejects.toMatchObject({
      code: "outside_workspace",
    });
    await expect(writeWorkspaceFile(root, "outdir/new.txt", "x", null)).rejects.toMatchObject({ code: "outside_workspace" });
    // A dangling link could point anywhere: writing through it would create a file outside.
    await expect(resolveWriteTarget(root, "dangling.txt")).rejects.toMatchObject({ code: "outside_workspace" });
    expect(await readFile(secret, "utf8")).toBe("top secret");
    expect(await readdir(outside.path)).toEqual(["secret.txt"]);

    const alias = await readWorkspaceFile(root, "alias.ts");
    expect(alias.content).toBe("export {};\n");

    const entries = await listDirectory(root, createIgnoreMatcher(root), "");
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    expect(byName["leak.txt"]).toMatchObject({ kind: "symlink", outsideWorkspace: true });
    expect(byName["outdir"]).toMatchObject({ kind: "symlink", outsideWorkspace: true });
    expect(byName["alias.ts"]).toMatchObject({ kind: "file", outsideWorkspace: false });
    expect(entries[0]?.name).toBe("src"); // directories first
  });
});

describe("read", () => {
  it("returns content, hash, eol, and flags binary and too-large files without their bytes", async () => {
    await workspace.write("crlf.txt", "a\r\nb\r\n");
    await workspace.write("bin.dat", new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    await workspace.write("big.txt", Buffer.alloc(FILE_EDIT_MAX_BYTES + 1, 97));

    const text = await readWorkspaceFile(root, "crlf.txt");
    expect(text).toMatchObject({ content: "a\r\nb\r\n", eol: "crlf", binary: false, tooLarge: false, size: 6 });
    expect(text.hash).toBe(sha256("a\r\nb\r\n"));
    expect(await readWorkspaceFile(root, "bin.dat")).toMatchObject({ content: null, binary: true });
    const big = await readWorkspaceFile(root, "big.txt");
    expect(big).toMatchObject({ content: null, tooLarge: true, size: FILE_EDIT_MAX_BYTES + 1 });
    expect(big.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("write with expected hash", () => {
  it("never overwrites when the file changed since it was read", async () => {
    await workspace.write("a.txt", "v1");
    const seen = (await readWorkspaceFile(root, "a.txt")).hash;
    await writeFile(join(root, "a.txt"), "changed by someone else");

    const result = await writeWorkspaceFile(root, "a.txt", "agent version", seen);
    expect(result).toEqual({ status: "conflict", path: "a.txt", currentHash: sha256("changed by someone else") });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("changed by someone else");
  });

  it("treats expectedHash null as 'must not exist' and writes atomically", async () => {
    await workspace.write("a.txt", "v1");
    expect(await writeWorkspaceFile(root, "a.txt", "x", null)).toMatchObject({ status: "conflict" });

    const created = await writeWorkspaceFile(root, "new.txt", "hello", null);
    expect(created).toEqual({ status: "written", path: "new.txt", hash: sha256("hello"), size: 5 });
    const updated = await writeWorkspaceFile(root, "new.txt", "hello 2", sha256("hello"));
    expect(updated.status).toBe("written");
    expect((await readdir(root)).sort()).toEqual(["a.txt", "new.txt"]); // no temp file left behind
  });
});

describe("create and move", () => {
  it("never replaces an existing entry", async () => {
    const matcher = createIgnoreMatcher(root);
    await createEntry(root, matcher, "dir", "directory");
    const file = await createEntry(root, matcher, "dir/a.ts", "file");
    expect(file).toMatchObject({ path: "dir/a.ts", kind: "file", size: 0 });
    await expect(createEntry(root, matcher, "dir/a.ts", "file")).rejects.toMatchObject({ code: "already_exists" });
    await workspace.write("b.ts", "b");
    await expect(moveEntry(root, matcher, "b.ts", "dir/a.ts")).rejects.toMatchObject({ code: "already_exists" });
    await expect(moveEntry(root, matcher, "dir", "dir/inner")).rejects.toMatchObject({ code: "invalid_path" });
    expect(await moveEntry(root, matcher, "b.ts", "dir/b.ts")).toMatchObject({ path: "dir/b.ts", kind: "file" });
  });
});

import { describe, expect, it } from "vitest";
import type { FileEntry } from "@nova/shared";
import type { DirListing } from "../../state/workspace-slice";
import { flattenVisibleRows, nameError, nextFocus, typeaheadMatch } from "./tree-model";

function entry(path: string, kind: FileEntry["kind"] = "file"): FileEntry {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind,
    size: null,
    mtimeMs: null,
    ignored: false,
    outsideWorkspace: false,
  };
}
const ready = (...entries: FileEntry[]): DirListing => ({ status: "ready", entries, error: null });

const dirs: Record<string, DirListing> = {
  "": ready(entry("src", "directory"), entry("tests", "directory"), entry("package.json"), entry("README.md")),
  src: ready(entry("src/lib", "directory"), entry("src/app.ts"), entry("src/api.ts")),
  "src/lib": ready(entry("src/lib/util.ts")),
};

describe("flattenVisibleRows", () => {
  it("shows only the content of expanded directories, depth first", () => {
    const rows = flattenVisibleRows(dirs, { src: true });
    expect(rows.map((row) => [row.path, row.depth])).toEqual([
      ["src", 1],
      ["src/lib", 2],
      ["src/app.ts", 2],
      ["src/api.ts", 2],
      ["tests", 1],
      ["package.json", 1],
      ["README.md", 1],
    ]);
  });

  it("adds a loading placeholder for an expanded directory not listed yet, and an error row", () => {
    const rows = flattenVisibleRows(
      { ...dirs, "src/lib": { status: "error", entries: [], error: { code: "internal", providerError: null } } },
      { src: true, "src/lib": true, tests: true },
    );
    expect(rows.find((row) => row.path === "src/lib#error")?.depth).toBe(3);
    expect(rows.find((row) => row.path === "tests#loading")?.kind).toBe("loading");
  });
});

describe("nextFocus", () => {
  const rows = flattenVisibleRows(dirs, { src: true });

  it("moves up and down, and to both ends", () => {
    expect(nextFocus(rows, "src", "ArrowDown")).toEqual({ type: "focus", path: "src/lib" });
    expect(nextFocus(rows, "src/lib", "ArrowUp")).toEqual({ type: "focus", path: "src" });
    expect(nextFocus(rows, "src", "ArrowUp")).toBeNull();
    expect(nextFocus(rows, "src/app.ts", "Home")).toEqual({ type: "focus", path: "src" });
    expect(nextFocus(rows, "src", "End")).toEqual({ type: "focus", path: "README.md" });
  });

  it("ArrowRight expands a closed directory, then enters it", () => {
    expect(nextFocus(rows, "src/lib", "ArrowRight")).toEqual({ type: "expand", path: "src/lib" });
    expect(nextFocus(rows, "src", "ArrowRight")).toEqual({ type: "focus", path: "src/lib" });
    expect(nextFocus(rows, "package.json", "ArrowRight")).toBeNull();
  });

  it("ArrowLeft collapses an open directory, else goes to the parent", () => {
    expect(nextFocus(rows, "src", "ArrowLeft")).toEqual({ type: "collapse", path: "src" });
    expect(nextFocus(rows, "src/api.ts", "ArrowLeft")).toEqual({ type: "focus", path: "src" });
    expect(nextFocus(rows, "README.md", "ArrowLeft")).toBeNull();
  });
});

describe("typeaheadMatch", () => {
  const rows = flattenVisibleRows(dirs, { src: true });

  it("finds the next row starting with the typed text, wrapping", () => {
    expect(typeaheadMatch(rows, "src", "r")).toBe("README.md");
    expect(typeaheadMatch(rows, "README.md", "p")).toBe("package.json");
    expect(typeaheadMatch(rows, "src/app.ts", "ap")).toBe("src/app.ts");
    expect(typeaheadMatch(rows, "src/app.ts", "api")).toBe("src/api.ts");
  });

  it("cycles through rows with a repeated letter", () => {
    expect(typeaheadMatch(rows, "src", "s")).toBe("src");
    expect(typeaheadMatch(rows, "src/app.ts", "a")).toBe("src/api.ts");
    expect(typeaheadMatch(rows, "src/api.ts", "aa")).toBe("src/app.ts");
  });
});

describe("nameError", () => {
  const messages = { empty: "vide", invalid: "invalide" };
  it.each([
    ["", "vide"],
    ["  ", "vide"],
    [".", "invalide"],
    ["..", "invalide"],
    ["a/b", "invalide"],
    ["a\\b", "invalide"],
    ["app.ts", null],
  ])("%j → %j", (name, expected) => {
    expect(nameError(name, messages)).toBe(expected);
  });
});

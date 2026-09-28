import { describe, expect, it } from "vitest";
import { createdFileDiff, hunkTargetLine, parseUnifiedDiff, reverseApply } from "./parse";

const MULTI = `diff --git a/src/form.tsx b/src/form.tsx
index 1111111..2222222 100644
--- a/src/form.tsx
+++ b/src/form.tsx
@@ -1,4 +1,7 @@ function validate()
 const email = input.value.trim();
-if (!email) return;
+if (!email) {
+  setError("Adresse manquante");
+  return;
+}
 send(email);
 done();
@@ -10,2 +13,2 @@
 a
-b
+c
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/a.js b/b.js
similarity index 90%
rename from a.js
rename to b.js
diff --git a/img.png b/img.png
index 5555555..6666666 100644
Binary files a/img.png and b/img.png differ
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(MULTI);

  it("splits files and detects the kind of change", () => {
    expect(files.map((file) => [file.path, file.change, file.binary])).toEqual([
      ["src/form.tsx", "modified", false],
      ["new.txt", "created", false],
      ["old.txt", "deleted", false],
      ["b.js", "moved", false],
      ["img.png", "modified", true],
    ]);
    expect(files[3]?.oldPath).toBe("a.js");
  });

  it("numbers old and new lines and counts additions and deletions", () => {
    const form = files[0];
    expect(form?.hunks).toHaveLength(2);
    expect(form?.additions).toBe(5);
    expect(form?.deletions).toBe(2);
    const first = form?.hunks[0];
    expect(first?.context).toBe("function validate()");
    expect(first?.header).toBe("@@ -1,4 +1,7 @@");
    expect(first?.lines[0]).toEqual({ kind: "context", oldNumber: 1, newNumber: 1, text: "const email = input.value.trim();" });
    expect(first?.lines[1]).toEqual({ kind: "del", oldNumber: 2, newNumber: null, text: "if (!email) return;" });
    expect(first?.lines[2]).toEqual({ kind: "add", oldNumber: null, newNumber: 2, text: "if (!email) {" });
    expect(first?.lines.at(-1)).toEqual({ kind: "context", oldNumber: 4, newNumber: 7, text: "done();" });
    expect(form?.hunks[1]?.index).toBe(1);
    expect(form && hunkTargetLine(form.hunks[0]!)).toBe(2);
  });

  it("records a missing final newline on the side it belongs to", () => {
    const created = files[1]?.hunks[0];
    expect(created?.newNoNewline).toBe(true);
    expect(created?.oldNoNewline).toBe(false);
    expect(created?.lines).toHaveLength(2);
  });
});

describe("reverseApply", () => {
  it("rebuilds the old text from the new text and the hunks", () => {
    const before = "const email = input.value.trim();\nif (!email) return;\nsend(email);\ndone();\nx\ny\nz\nw\nv\na\nb\n";
    const after =
      'const email = input.value.trim();\nif (!email) {\n  setError("Adresse manquante");\n  return;\n}\nsend(email);\ndone();\nx\ny\nz\nw\nv\na\nc\n';
    const hunks = parseUnifiedDiff(MULTI)[0]?.hunks ?? [];
    expect(reverseApply(after, hunks)).toBe(before);
  });

  it("handles created and deleted files and final newlines", () => {
    const [, created, deleted] = parseUnifiedDiff(MULTI);
    expect(reverseApply("hello\nworld", created?.hunks ?? [])).toBe("");
    expect(reverseApply("", deleted?.hunks ?? [])).toBe("bye\n");
  });

  it("refuses a file that no longer matches the diff", () => {
    const hunks = parseUnifiedDiff(MULTI)[0]?.hunks ?? [];
    expect(() => reverseApply("something else entirely\n", hunks)).toThrow("file differs from the diff");
  });

  it("round-trips a created file diff", () => {
    const diff = createdFileDiff("n.ts", "a\nb\n");
    expect(diff.additions).toBe(2);
    expect(reverseApply("a\nb\n", diff.hunks)).toBe("");
  });
});

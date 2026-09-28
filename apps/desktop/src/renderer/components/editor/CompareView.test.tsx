// The compare view keeps the user's merge when the disk changes again under it.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { CompareView } from "./CompareView";
import { installEditorDomPolyfills } from "./test-dom";

installEditorDomPolyfills();
afterEach(cleanup);

function sides(): { disk: EditorView; mine: EditorView } {
  const [disk, mine] = [...document.querySelectorAll<HTMLElement>(".cm-editor")].map((dom) => EditorView.findFromDOM(dom));
  if (!disk || !mine) throw new Error("no merge view");
  return { disk, mine };
}

describe("CompareView", () => {
  it("shows a newer disk version on its side and keeps the merge in progress", () => {
    const props = { path: "src/app.ts", mineText: "mine\n", onApply: () => undefined, onCancel: () => undefined };
    const { rerender } = render(<CompareView {...props} diskText={"disk v1\n"} />);
    const before = sides();
    act(() => before.mine.dispatch({ changes: { from: 0, insert: "merged " } }));
    rerender(<CompareView {...props} diskText={"disk v2\n"} />);
    const after = sides();
    expect(after.mine.state.doc.toString()).toBe("merged mine\n");
    expect(after.disk.state.doc.toString()).toBe("disk v2\n");
    expect(screen.getByText(/Le disque a encore changé/)).toBeTruthy();
  });
});

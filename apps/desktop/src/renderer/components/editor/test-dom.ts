// jsdom has no layout: CodeMirror measures text through Range geometry. Test-only polyfills.
import { installDomPolyfills } from "../../test/dom";

export function installEditorDomPolyfills(): void {
  installDomPolyfills();
  const empty = (): DOMRect => new DOMRect(0, 0, 0, 0);
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function getClientRects() {
      return Object.assign([], { item: () => null }) as unknown as DOMRectList;
    };
  }
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = empty;
}

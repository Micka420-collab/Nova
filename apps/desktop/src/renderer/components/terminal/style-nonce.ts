// xterm.js 6 creates <style> elements without a nonce (verified in its source):
// - browser/Viewport.ts: scrollbar slider colors, created in `open()` for every renderer;
// - browser/renderer/dom/DomRenderer.ts: dimensions and theme, only for the DOM renderer (used
//   when WebGL is unavailable, or after a WebGL context loss).
// The page CSP is `style-src 'self' 'nonce-…'` (ADR-013), so those elements would be blocked.
// `withStyleNonce` stamps the page nonce on every <style> the document creates while `run` executes
// (synchronously: `term.open()`, `webglAddon.dispose()`), before xterm fills and inserts it. The
// override is an own property of this document only, removed in `finally`.
// Not covered (known): the DOM renderer also sets per-cell `style` attributes for contrast-adjusted
// and truecolor foregrounds; CSP blocks those without 'unsafe-inline', so the degraded renderer loses
// them. The WebGL renderer draws on a canvas and has neither.

export function withStyleNonce<T>(doc: Document, nonce: string | null, run: () => T): T {
  if (!nonce) return run();
  const own = Object.getOwnPropertyDescriptor(doc, "createElement");
  const original = doc.createElement;
  const stamped = function (this: Document, ...args: Parameters<Document["createElement"]>): HTMLElement {
    const element = original.apply(this, args);
    if (element instanceof HTMLStyleElement) element.nonce = nonce;
    return element;
  };
  Object.defineProperty(doc, "createElement", { value: stamped, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (own) Object.defineProperty(doc, "createElement", own);
    // Without a previous own property, deleting ours restores Document.prototype.createElement.
    else delete (doc as unknown as { createElement?: unknown }).createElement;
  }
}

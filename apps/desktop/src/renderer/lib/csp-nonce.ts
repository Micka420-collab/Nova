// Style nonce of this page load (ADR-013). Main injects `<meta name="nova-style-nonce">` into
// index.html and allows `style-src 'nonce-…'` for this load only. Pass it to CodeMirror with
// `EditorView.cspNonce.of(nonce)`; a <style> element created by NOVA code sets `style.nonce = nonce`.
// null under the Vite dev server (its CSP allows inline styles) or if the meta is missing.
const STYLE_NONCE_META = "nova-style-nonce";

let cached: string | null | undefined;

export function readStyleNonce(doc: Pick<Document, "querySelector"> = document): string | null {
  const content = doc.querySelector<HTMLMetaElement>(`meta[name="${STYLE_NONCE_META}"]`)?.content;
  return content && /^[A-Za-z0-9+/_-]+=*$/.test(content) ? content : null;
}

/** Nonce of the current document, read once. */
export function styleNonce(): string | null {
  if (cached === undefined) cached = readStyleNonce();
  return cached;
}

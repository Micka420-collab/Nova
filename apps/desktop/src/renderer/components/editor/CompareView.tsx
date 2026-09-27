// Side-by-side comparison of the disk version and the user's buffer (@codemirror/merge), opened
// from the conflict banner. The user's side stays editable; margin arrows copy a disk block into it.
import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Button } from "@nova/ui";
import { styleNonce } from "../../lib/csp-nonce";
import { novaHighlighter } from "./codemirror/highlight";
import { loadLanguage } from "./codemirror/languages";
import { frenchPhrases } from "./codemirror/phrases";
import { editorCopy } from "./copy";

export interface CompareViewProps {
  path: string;
  diskText: string;
  mineText: string;
  onApply(text: string): void;
  onCancel(): void;
}

function sideExtensions(label: string, language: Compartment, readOnly: boolean): Extension[] {
  const nonce = styleNonce();
  return [
    nonce ? EditorView.cspNonce.of(nonce) : [],
    frenchPhrases,
    EditorView.editorAttributes.of({ class: "nv-code-editor" }),
    EditorView.contentAttributes.of({ "aria-label": label }),
    lineNumbers(),
    syntaxHighlighting(novaHighlighter),
    language.of([]),
    readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
  ];
}

export function CompareView({ path, diskText, mineText, onApply, onCancel }: CompareViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const languageA = new Compartment();
    const languageB = new Compartment();
    const view = new MergeView({
      a: { doc: diskText, extensions: sideExtensions(editorCopy.compareDisk, languageA, true) },
      b: { doc: mineText, extensions: sideExtensions(editorCopy.compareMine, languageB, false) },
      parent: host,
      revertControls: "a-to-b",
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    viewRef.current = view;
    let disposed = false;
    void loadLanguage(path).then((support) => {
      if (disposed || !support) return;
      view.a.dispatch({ effects: languageA.reconfigure(support) });
      view.b.dispatch({ effects: languageB.reconfigure(support) });
    });
    return () => {
      disposed = true;
      viewRef.current = null;
      view.destroy();
    };
  }, [path, diskText, mineText]);

  return (
    <section className="nv-compare" aria-label={editorCopy.compareLabel}>
      <div className="nv-compare__header">
        <span className="nv-compare__side">{editorCopy.compareDisk}</span>
        <span className="nv-compare__side">{editorCopy.compareMine}</span>
      </div>
      <div ref={hostRef} className="nv-compare__body" />
      <div className="nv-compare__footer">
        <p className="nv-compare__hint">{editorCopy.compareHint}</p>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {editorCopy.compareCancel}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const view = viewRef.current;
            if (view) onApply(view.b.state.doc.toString());
          }}
        >
          {editorCopy.compareApply}
        </Button>
      </div>
    </section>
  );
}

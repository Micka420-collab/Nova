// Read-only side-by-side view of one file (@codemirror/merge). The "before" text is rebuilt from
// the disk content and the patch; a mismatch means the file changed since the diff was computed.
import { useEffect, useRef, useState } from "react";
import { Callout } from "@nova/ui";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { fr } from "../../copy/fr";
import { styleNonce } from "../../lib/csp-nonce";
import { useClient } from "../../state/context";
import { reverseApply, type DiffFileData } from "./parse";

function readOnly(): Extension[] {
  const nonce = styleNonce();
  return [
    lineNumbers(),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
  ];
}

type Loaded = { status: "loading" } | { status: "ready"; before: string; after: string } | { status: "mismatch" };

export function SideBySide({ workspaceId, file }: { workspaceId: string; file: DiffFileData }) {
  const client = useClient();
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let current = true;
    const load = async (): Promise<Loaded> => {
      if (file.change === "deleted") {
        return { status: "ready", before: reverseApply("", file.hunks), after: "" };
      }
      const content = await client.files.read({ workspaceId, path: file.path });
      if (content.content === null) return { status: "mismatch" };
      return { status: "ready", before: reverseApply(content.content, file.hunks), after: content.content };
    };
    load()
      .catch((): Loaded => ({ status: "mismatch" }))
      .then((next) => {
        if (current) setLoaded(next);
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, file]);

  useEffect(() => {
    const parent = host.current;
    if (loaded.status !== "ready" || !parent) return;
    const view = new MergeView({
      a: { doc: loaded.before, extensions: readOnly() },
      b: { doc: loaded.after, extensions: readOnly() },
      parent,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    return () => view.destroy();
  }, [loaded]);

  if (loaded.status === "loading") return <p className="nova-diff__note">{fr.diff.review.sideBySideLoading}</p>;
  if (loaded.status === "mismatch") return <Callout tone="warning">{fr.diff.review.sideBySideUnavailable}</Callout>;
  return <div ref={host} className="nova-diff__merge" />;
}

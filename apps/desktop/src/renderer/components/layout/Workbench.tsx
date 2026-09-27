// Workbench (VISUAL.md §3 "plan de travail"): documents as tabs — context, editor group, mission
// card, change review, checkpoints, extensions. Each document owns its states; this only hosts them.
import { Tabs, tabPanelProps, type TabItem } from "@nova/ui";
import { fr } from "../../copy/fr";
import { useApp } from "../../state/context";
import { docKey, liveMission, type WorkbenchDoc } from "../../state/store";
import { CheckpointsView } from "../diff/CheckpointsView";
import { DiffReview } from "../diff/DiffReview";
import { EditorWorkbench } from "../editor/EditorWorkbench";
import { McpManager } from "../extensions/McpManager";
import { MissionCard } from "../missions/MissionCard";
import { ContextPanel } from "./ContextPanel";
import { useMemo } from "react";

const copy = fr.atelier.shell;
const ID_PREFIX = "wb";
const EMPTY_SET: ReadonlySet<string> = new Set();

function useDocLabel(): (doc: WorkbenchDoc) => string {
  const views = useApp((state) => state.missions.views);
  return (doc) => {
    switch (doc.kind) {
      case "context":
        return copy.context;
      case "editor":
        return copy.editor;
      case "mission":
        return copy.missionDoc(views[doc.missionId]?.mission.title ?? fr.app.unknown);
      case "diff":
        return copy.diffDoc;
      case "checkpoints":
        return copy.checkpointsDoc;
      case "extensions":
        return copy.extensions;
    }
  };
}

/** Files the running mission is writing right now (real `tool.started` events only). */
function useAgentWritingPaths(): ReadonlySet<string> {
  const view = useApp(liveMission);
  return useMemo(() => {
    if (!view) return EMPTY_SET;
    const paths = view.items.flatMap((item) =>
      item.kind === "tool" && item.state === "running" && item.call.path && (item.call.operation === "write" || item.call.operation === "delete")
        ? [item.call.path]
        : [],
    );
    return paths.length > 0 ? new Set(paths) : EMPTY_SET;
  }, [view]);
}

function DocView({ doc }: { doc: WorkbenchDoc }) {
  const setUi = useApp((state) => state.setUi);
  const showExplorer = useApp((state) => state.showExplorer);
  const writing = useAgentWritingPaths();
  switch (doc.kind) {
    case "context":
      return <ContextPanel />;
    case "editor":
      return (
        <EditorWorkbench
          agentWritingPaths={writing}
          onQuickOpen={() => setUi({ quickOpen: true })}
          onProjectSearch={() => showExplorer("search")}
        />
      );
    case "mission":
      return <MissionCard missionId={doc.missionId} />;
    case "diff":
      return <DiffReview missionId={doc.missionId} />;
    case "checkpoints":
      return <CheckpointsView missionId={doc.missionId} />;
    case "extensions":
      return <McpManager />;
  }
}

export function Workbench() {
  const docs = useApp((state) => state.ui.docs);
  const activeDoc = useApp((state) => state.ui.activeDoc);
  const setUi = useApp((state) => state.setUi);
  const closeDoc = useApp((state) => state.closeDoc);
  const label = useDocLabel();
  const active = docs.find((doc) => docKey(doc) === activeDoc) ?? docs[0];
  const items: TabItem[] = docs.map((doc) => {
    const text = label(doc);
    return {
      key: docKey(doc),
      label: text,
      title: text,
      closable: doc.kind !== "context",
      closeLabel: copy.closeDoc(text),
    };
  });
  return (
    <section className="nova-workbench" aria-label={copy.workbenchLabel}>
      <Tabs
        label={copy.workbenchTabs}
        idPrefix={ID_PREFIX}
        items={items}
        activeKey={active ? docKey(active) : "context"}
        onSelect={(key) => setUi({ activeDoc: key })}
        onClose={closeDoc}
        className="nova-workbench__tabs"
      />
      {active ? (
        <div {...tabPanelProps(ID_PREFIX, docKey(active))} className="nova-workbench__doc" key={docKey(active)}>
          <DocView doc={active} />
        </div>
      ) : null}
    </section>
  );
}

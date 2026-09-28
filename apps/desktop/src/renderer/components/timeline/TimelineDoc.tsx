// Search in the missions' journals, as a workbench document (J2-B L8). A hit opens its mission in
// the agent panel; nothing renders while main answers `unavailable`.
import { fr } from "../../copy/fr";
import { useApp } from "../../state/context";
import { TimelineSearch } from "./TimelineSearch";

export function TimelineDoc() {
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const missionId = useApp((state) => state.missions.selectedId);
  const selectMission = useApp((state) => state.selectMission);
  const setUi = useApp((state) => state.setUi);
  return (
    <section className="nova-timeline-doc" aria-label={fr.atelier.shell.searchTimeline}>
      <TimelineSearch
        workspaceId={workspaceId}
        missionId={missionId}
        onOpen={(hit) => {
          selectMission(hit.missionId);
          setUi({ route: "chat", agentOpen: true, contextOverlayOpen: false });
        }}
      />
    </section>
  );
}

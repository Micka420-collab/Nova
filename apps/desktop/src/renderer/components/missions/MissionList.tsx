// Missions of the open project, in the explorer column (UX.md §4.3 "Missions" space).
import { EmptyState, Skeleton, StatusPill } from "@nova/ui";
import { fr } from "../../copy/fr";
import { MISSION_STATE_LABELS } from "../../copy/fr-atelier";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { MISSION_STATE_TONES, MissionListFailed } from "../agent/AgentPanel";

const copy = fr.atelier;

export function MissionList() {
  const list = useApp((state) => state.missions.list);
  const status = useApp((state) => state.missions.listStatus);
  const selectedId = useApp((state) => state.missions.selectedId);
  const selectMission = useApp((state) => state.selectMission);
  const openDoc = useApp((state) => state.openDoc);
  const setUi = useApp((state) => state.setUi);
  const now = useNow(60_000);

  if (status === "error") return <MissionListFailed />;
  if (status === "loading" || status === "idle") {
    return (
      <div className="nova-mlist" aria-busy="true">
        <p className="nv-visually-hidden">{copy.mission.listLoading}</p>
        <Skeleton height={44} radius={10} />
        <Skeleton height={44} radius={10} />
      </div>
    );
  }
  if (list.length === 0) {
    return <EmptyState title={copy.mission.empty} description={copy.mission.emptyBody} headingLevel={3} />;
  }
  return (
    <ul className="nova-mlist">
      {list.map((mission) => (
        <li key={mission.id}>
          <button
            type="button"
            className="nova-mlist__item"
            aria-current={mission.id === selectedId ? "true" : undefined}
            onClick={() => {
              selectMission(mission.id);
              openDoc({ kind: "mission", missionId: mission.id });
              setUi({ route: "chat", agentOpen: true, navOpen: false });
            }}
          >
            <span className="nova-mlist__title">{mission.title}</span>
            <StatusPill tone={MISSION_STATE_TONES[mission.state]} active={mission.state === "running"}>
              {MISSION_STATE_LABELS[mission.state]}
            </StatusPill>
            <span className="nova-mlist__time">{formatRelative(mission.updatedAt, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

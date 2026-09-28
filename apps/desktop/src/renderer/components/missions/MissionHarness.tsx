// J2-B panels of the selected mission, in the agent panel's journal (mounted once, so each region is
// unique on the page). Every lane component renders nothing while its group answers `unavailable`
// or has nothing to show: a mission without these features looks exactly like a J2-A one.
import { useApp, useClient } from "../../state/context";
import { useHarnessStores } from "../../state/harness-stores";
import { MissionContextPanel } from "../context";
import { useOptionalShellServices } from "../layout/AtelierHost";
import { MissionProcesses } from "../processes/MissionProcesses";
import { MissionSkills } from "../skills/MissionSkills";
import { SubmissionTree } from "../submissions/SubmissionTree";
import { ContinuationStatus } from "../timeline";
import type { MissionView } from "./timeline";

/** Above the journal: « Jusqu'à preuve » rounds (or the fork origin) and the context gauge. */
export function MissionHarnessHeader({ view }: { view: MissionView }) {
  const selectMission = useApp((state) => state.selectMission);
  return (
    <>
      <ContinuationStatus view={view.harness.continuation} onOpenMission={selectMission} />
      <MissionContextPanel view={view} />
    </>
  );
}

/** Below the journal: background processes, sub-missions and the skills the mission loaded. */
export function MissionHarnessPanels({ view }: { view: MissionView }) {
  const client = useClient();
  const stores = useHarnessStores();
  const shell = useOptionalShellServices();
  const selectMission = useApp((state) => state.selectMission);
  const setUi = useApp((state) => state.setUi);
  const missionId = view.mission.id;
  const showTerminal = shell
    ? (sessionId: string) => {
        shell.terminal.getState().reveal(sessionId);
        setUi({ dockOpen: true });
      }
    : undefined;
  return (
    <div className="nova-mission-harness">
      <MissionProcesses
        api={client.processes}
        store={stores.processes}
        missionId={missionId}
        {...(showTerminal ? { onShowTerminal: showTerminal } : {})}
      />
      <SubmissionTree store={stores.submissions} missionId={missionId} onOpenMission={selectMission} />
      <MissionSkills view={view.harness.skills} />
    </div>
  );
}

// Scheduled missions of the open project, as a workbench document (J2-B L6). The manager itself
// says it only runs while NOVA is open and shows nothing while main answers `unavailable`.
import { fr } from "../../copy/fr";
import { useApp, useClient } from "../../state/context";
import { useHarnessStores } from "../../state/harness-stores";
import { selectedModelId } from "../../state/store";
import { SchedulesManager } from "./SchedulesManager";

export function SchedulesDoc() {
  const client = useClient();
  const { schedules } = useHarnessStores();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const models = useApp((state) => state.catalog.data?.models ?? null);
  const defaultModelId = useApp((state) => selectedModelId(state, null));
  const openDoc = useApp((state) => state.openDoc);
  if (!workspaceId) return <p className="nova-note">{fr.atelier.shell.noWorkspace}</p>;
  return (
    <SchedulesManager
      api={client.schedules}
      store={schedules}
      workspaceId={workspaceId}
      models={models}
      defaultModelId={defaultModelId}
      onOpenMission={(missionId) => openDoc({ kind: "mission", missionId })}
    />
  );
}

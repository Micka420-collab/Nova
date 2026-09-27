// Status bar (VISUAL.md §3): work mode, branch, changed files, budget of the running mission, Nomi's
// mission state, pending approvals, display and layout. Only recorded facts; unknown stays absent.
import { BudgetMeter, OrbitIndicator, StatusBar, StatusBarItem } from "@nova/ui";
import { fr } from "../../copy/fr";
import { WORK_MODE_LABELS } from "../../copy/fr-atelier";
import { MOD_KEY } from "../../lib/platform";
import { useApp } from "../../state/context";
import { liveMission, pendingApprovalList } from "../../state/store";
import { budgetFormat } from "../agent/AgentPanel";

const copy = fr.atelier.statusBar;

export function AtelierStatusBar({ agentVisible }: { agentVisible: boolean }) {
  const mode = useApp((state) => state.workMode);
  const workspace = useApp((state) => state.workspace.current);
  const git = useApp((state) => state.workspace.git);
  const approvals = useApp((state) => state.approvals);
  const mission = useApp(liveMission);
  const suspended = useApp((state) => Object.values(state.missions.views).some((view) => view.mission.state === "suspended"));
  const displayMode = useApp((state) => state.ui.displayMode);
  const layout = useApp((state) => state.ui.layout);
  const toggleDisplayMode = useApp((state) => state.toggleDisplayMode);
  const toggleLayout = useApp((state) => state.toggleLayout);
  const focusApproval = useApp((state) => state.focusApproval);
  const setUi = useApp((state) => state.setUi);
  const pending = pendingApprovalList({ approvals });
  const oldest = pending[0];
  const running = mission?.mission.state === "running";

  const start = (
    <>
      <StatusBarItem onClick={() => setUi({ route: "chat", agentOpen: true })} title={copy.mode(WORK_MODE_LABELS[mode])}>
        {copy.mode(WORK_MODE_LABELS[mode])}
      </StatusBarItem>
      {workspace ? (
        <>
          <StatusBarItem title={workspace.displayPath}>{workspace.name}</StatusBarItem>
          {git?.available ? (
            <>
              <StatusBarItem>{git.branch ? copy.branch(git.branch) : copy.detached}</StatusBarItem>
              <StatusBarItem>{git.entries.length > 0 ? copy.changed(git.entries.length) : copy.clean}</StatusBarItem>
            </>
          ) : null}
        </>
      ) : (
        <StatusBarItem>{copy.noWorkspace}</StatusBarItem>
      )}
    </>
  );

  const end = (
    <>
      {mission?.budget ? (
        <BudgetMeter
          variant="inline"
          spentUsd={mission.budget.spentUsd}
          reservedUsd={mission.budget.reservedUsd}
          capUsd={mission.budget.budgetUsd}
          unknownCostCalls={mission.budget.unknownCostCalls}
          format={budgetFormat}
          labels={fr.atelier.budget}
        />
      ) : null}
      {mission ? (
        <StatusBarItem tone={running ? "jade" : "amber"} onClick={() => setUi({ route: "chat", agentOpen: true })}>
          {/* The agent panel header carries the orbit when it is visible (single focus). */}
          {running && !agentVisible ? <OrbitIndicator active size={12} /> : null}
          {running ? copy.missionRunning : copy.missionWaiting}
        </StatusBarItem>
      ) : suspended ? (
        <StatusBarItem tone="amber">{copy.missionSuspended}</StatusBarItem>
      ) : null}
      {oldest ? (
        <StatusBarItem tone="amber" onClick={() => focusApproval(oldest.id)} title={`${copy.approvals(pending.length)} (${MOD_KEY}+Maj+A)`}>
          {copy.approvals(pending.length)}
        </StatusBarItem>
      ) : null}
      <StatusBarItem onClick={toggleDisplayMode} title={`${fr.atelier.commands.toggleDisplay} (${MOD_KEY}+Maj+E)`}>
        {copy.display[displayMode]}
      </StatusBarItem>
      <StatusBarItem onClick={toggleLayout} title={`${fr.atelier.commands.toggleLayout} (${MOD_KEY}+Maj+D)`}>
        {copy.layout[layout]}
      </StatusBarItem>
    </>
  );

  return <StatusBar label={copy.label} start={start} end={end} className="nova-statusbar" />;
}

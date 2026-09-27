// Réglages › Budget (Mo5/Mo6, UX.md §5.8/§7.5): default caps (facts), today's spend from the latest
// budget main reported, and the observed cost of the project's recent missions (CSV copy).
import { useEffect, useState } from "react";
import { BudgetMeter, Button, Callout, useToast } from "@nova/ui";
import {
  DEFAULT_DAILY_BUDGET_USD,
  DEFAULT_MISSION_BUDGET_USD,
  DEFAULT_MISSION_MAX_DURATION_MS,
  type Mission,
  type MissionBudget,
} from "@nova/shared";
import { fr } from "../../copy/fr";
import { MISSION_STATE_LABELS } from "../../copy/fr-atelier";
import { errorToast, toUiError, type UiError } from "../../lib/errors";
import { formatCost } from "../../lib/format";
import { useApp, useClient } from "../../state/context";
import { SectionError, SectionLoading } from "./section-states";

const copy = fr.atelierSettings.budget;
export const REPORT_LIMIT = 10;

const usd = (value: number) => formatCost(value) ?? fr.app.unknown;

type CostState = { status: "loading" } | { status: "ready"; budget: MissionBudget } | { status: "error"; error: UiError };

export interface CostRow {
  mission: Mission;
  budget: MissionBudget | null;
}

function csvField(value: string): string {
  return /[",\n;]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** CSV of the cost report; an unknown cost stays an empty cell, never 0. Exported for tests. */
export function costReportCsv(rows: readonly CostRow[]): string {
  const lines = [copy.csvHeader.join(",")];
  for (const { mission, budget } of rows) {
    lines.push(
      [
        csvField(mission.title),
        mission.state,
        budget ? String(budget.spentUsd) : "",
        budget ? String(budget.unknownCostCalls) : "",
        new Date(mission.createdAt).toISOString(),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function costText(budget: MissionBudget): string {
  const cost = usd(budget.spentUsd);
  return budget.unknownCostCalls > 0 ? copy.atLeast(cost, budget.unknownCostCalls) : cost;
}

function Defaults() {
  const minutes = Math.round(DEFAULT_MISSION_MAX_DURATION_MS / 60_000);
  return (
    <section className="nova-aset-block" aria-labelledby="aset-budget-defaults">
      <h3 id="aset-budget-defaults" className="nova-subheading">
        {copy.defaultsTitle}
      </h3>
      <dl className="nova-facts">
        <dt>{copy.perMission}</dt>
        <dd>
          {usd(DEFAULT_MISSION_BUDGET_USD)} <span className="nova-note">· {copy.perMissionHint}</span>
        </dd>
        <dt>{copy.perDay}</dt>
        <dd>{usd(DEFAULT_DAILY_BUDGET_USD)}</dd>
        <dt>{copy.duration}</dt>
        <dd>{copy.minutes(minutes)}</dd>
      </dl>
      <p className="nova-note">{copy.whereToChange}</p>
    </section>
  );
}

function Today({ budget }: { budget: MissionBudget | null }) {
  return (
    <section className="nova-aset-block" aria-labelledby="aset-budget-today">
      <h3 id="aset-budget-today" className="nova-subheading">
        {copy.todayTitle}
      </h3>
      {budget === null ? <p className="nova-aset-empty">{copy.todayUnknown}</p> : null}
      {budget !== null && budget.dailySpentUsd === 0 ? <p className="nova-aset-empty">{copy.todayNone}</p> : null}
      {budget !== null && budget.dailySpentUsd > 0 ? (
        <BudgetMeter
          variant="card"
          spentUsd={budget.dailySpentUsd}
          reservedUsd={0}
          capUsd={budget.dailyLimitUsd}
          // Main reports unknown-cost calls per mission only; the daily total says nothing more.
          unknownCostCalls={0}
          format={usd}
          labels={fr.atelier.budget}
          suspended={budget.dailySpentUsd >= budget.dailyLimitUsd}
        />
      ) : null}
    </section>
  );
}

function Report({ missions, costs, onRetry }: { missions: Mission[]; costs: Record<string, CostState>; onRetry: () => void }) {
  const toast = useToast();
  const rows: CostRow[] = missions.map((mission) => {
    const cost = costs[mission.id];
    return { mission, budget: cost?.status === "ready" ? cost.budget : null };
  });
  const failed = Object.values(costs).find((cost): cost is Extract<CostState, { status: "error" }> => cost.status === "error");

  async function copyCsv() {
    try {
      await navigator.clipboard.writeText(costReportCsv(rows));
      toast.show({ title: copy.copied, tone: "success" });
    } catch (error) {
      toast.show(errorToast(error, copy.copyFailed));
    }
  }

  if (missions.length === 0) return <p className="nova-aset-empty">{copy.reportEmpty}</p>;
  return (
    <>
      {failed ? <SectionError error={failed.error} onRetry={onRetry} /> : null}
      <div className="nova-aset-table-wrap">
        <table className="nova-aset-table">
          <caption className="nv-visually-hidden">{copy.reportTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.colMission}</th>
              <th scope="col">{copy.colState}</th>
              <th scope="col" className="nova-aset-num">
                {copy.colCost}
              </th>
            </tr>
          </thead>
          <tbody>
            {missions.map((mission) => {
              const cost = costs[mission.id];
              return (
                <tr key={mission.id}>
                  <td>{mission.title}</td>
                  <td>{MISSION_STATE_LABELS[mission.state]}</td>
                  <td className="nova-aset-num">
                    {cost?.status === "ready" ? costText(cost.budget) : cost?.status === "error" ? fr.app.unknown : copy.costLoading}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="nova-actions">
        <Button variant="secondary" size="sm" onClick={() => void copyCsv()}>
          {copy.copyCsv}
        </Button>
        <span className="nova-note">{copy.shown(missions.length)}</span>
      </div>
    </>
  );
}

export function BudgetSection() {
  const client = useClient();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const list = useApp((state) => state.missions.list);
  const listStatus = useApp((state) => state.missions.listStatus);
  const listError = useApp((state) => state.missions.listError);
  const views = useApp((state) => state.missions.views);
  const refreshMissions = useApp((state) => state.refreshMissions);
  const [costs, setCosts] = useState<Record<string, CostState>>({});
  const [attempt, setAttempt] = useState(0);

  const missions = list
    .filter((mission) => mission.workspaceId === workspaceId)
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, REPORT_LIMIT);
  const missionIds = missions.map((mission) => mission.id).join(",");

  useEffect(() => {
    if (workspaceId && listStatus === "idle") void refreshMissions();
  }, [workspaceId, listStatus, refreshMissions]);

  // Budgets come from main (missions.get); a budget already followed live is reused as is.
  useEffect(() => {
    let current = true;
    for (const id of missionIds ? missionIds.split(",") : []) {
      const known = views[id]?.budget;
      if (known) {
        setCosts((state) => ({ ...state, [id]: { status: "ready", budget: known } }));
        continue;
      }
      setCosts((state) => (state[id]?.status === "ready" ? state : { ...state, [id]: { status: "loading" } }));
      client.missions
        .get({ missionId: id, afterSeq: 0 })
        .then((detail) => current && setCosts((state) => ({ ...state, [id]: { status: "ready", budget: detail.budget } })))
        .catch((error: unknown) => current && setCosts((state) => ({ ...state, [id]: { status: "error", error: toUiError(error) } })));
    }
    return () => {
      current = false;
    };
    // Views change on every live event; reading them once per mission list is enough here.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [client, missionIds, attempt]);

  // Latest budget reported by main: the most recently updated mission that has one.
  const budgets = [
    ...Object.values(views).flatMap((view) => (view.budget ? [{ at: view.mission.updatedAt, budget: view.budget }] : [])),
    ...missions.flatMap((mission) => {
      const cost = costs[mission.id];
      return cost?.status === "ready" ? [{ at: mission.updatedAt, budget: cost.budget }] : [];
    }),
  ];
  const latest = budgets.toSorted((a, b) => b.at - a.at)[0]?.budget ?? null;

  return (
    <div className="nova-aset">
      <Defaults />
      <Today budget={latest} />
      <section className="nova-aset-block" aria-labelledby="aset-budget-report">
        <h3 id="aset-budget-report" className="nova-subheading">
          {copy.reportTitle}
        </h3>
        {!workspaceId ? <p className="nova-aset-empty">{copy.reportNoWorkspace}</p> : null}
        {workspaceId && listStatus === "error" && listError ? (
          <SectionError error={listError} onRetry={() => void refreshMissions()} />
        ) : null}
        {workspaceId && (listStatus === "loading" || listStatus === "idle") ? <SectionLoading label={copy.reportLoading} /> : null}
        {workspaceId && listStatus === "ready" ? (
          <Report missions={missions} costs={costs} onRetry={() => setAttempt((n) => n + 1)} />
        ) : null}
      </section>
      <section className="nova-aset-block" aria-labelledby="aset-budget-amounts">
        <h3 id="aset-budget-amounts" className="nova-subheading">
          {copy.amountsTitle}
        </h3>
        <ul className="nova-bullets">
          {copy.amounts.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Callout tone="info">{copy.billingNote}</Callout>
      </section>
    </div>
  );
}

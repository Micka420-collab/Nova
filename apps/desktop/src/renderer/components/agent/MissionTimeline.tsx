// Live journal of a mission in the agent panel (VISUAL.md §4.4): messages with citation chips, tool
// cards (folded, grouped), approvals in place, notices, suspension banner and the end card.
import { useId, useState } from "react";
import { Button, Callout, CitationChip, useToast } from "@nova/ui";
import { fr } from "../../copy/fr";
import { SUSPEND_REASON_COPY } from "../../copy/fr-atelier";
import { errorToast } from "../../lib/errors";
import { formatCost, formatInteger } from "../../lib/format";
import { useApp } from "../../state/context";
import { groupTimeline, type MessageItem, type MissionView, type NoticeItem } from "../missions/timeline";
import { AgentApproval } from "./AgentApproval";
import { splitCitations } from "./citations";
import { EndCard } from "./EndCard";
import { ToolCard, ToolGroupCard } from "./ToolCard";

const copy = fr.atelier;

function MessageText({ text }: { text: string }) {
  const revealFile = useApp((state) => state.revealFile);
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="nova-agent-msg__p">
          {splitCitations(paragraph).map((part, partIndex) =>
            part.kind === "text" ? (
              <span key={partIndex}>{part.text}</span>
            ) : (
              <CitationChip
                key={partIndex}
                kind="file"
                label={part.label}
                title={part.line ? `${part.path}:${part.line}` : part.path}
                accessibleName={
                  part.line ? `${copy.timeline.openFile} ${part.path} ${copy.timeline.lines(part.line, part.line)}` : `${copy.timeline.openFile} ${part.path}`
                }
                onOpen={() => revealFile(part.path, part.line)}
              />
            ),
          )}
        </p>
      ))}
    </>
  );
}

function AgentMessage({ item }: { item: MessageItem }) {
  const usage = item.usage;
  return (
    <article className="nova-agent-msg" aria-busy={!item.complete}>
      <p className="nova-agent-msg__author">{copy.agent.nomi}</p>
      <MessageText text={item.text} />
      {!item.complete ? <p className="nova-note">{copy.agent.streaming}</p> : null}
      {item.complete && usage && (usage.promptTokens !== null || usage.completionTokens !== null) ? (
        <p className="nova-agent-msg__usage">
          {copy.timeline.usage(
            usage.promptTokens === null ? fr.app.unknown : formatInteger(usage.promptTokens),
            usage.completionTokens === null ? fr.app.unknown : formatInteger(usage.completionTokens),
          )}
        </p>
      ) : null}
    </article>
  );
}

function Notice({ item }: { item: NoticeItem }) {
  const { notice } = item;
  switch (notice.type) {
    case "plan":
      return <p className="nova-agent-notice">{copy.timeline.plan(notice.taskCount)}</p>;
    case "checkpoint":
      // Journaled when created, before the write fills it: its file count is always 0 here.
      return <p className="nova-agent-notice">{copy.timeline.checkpoint}</p>;
    case "proof":
      return <p className="nova-agent-notice nova-agent-notice--proof">{copy.timeline.proof(notice.proof.summary)}</p>;
    case "resumed":
      return <p className="nova-agent-notice">{copy.timeline.resumed}</p>;
    case "review":
      return <p className="nova-agent-notice">{copy.timeline.review(notice.decisions.length)}</p>;
    case "suspended":
      // The live banner below states the current suspension; past ones are one line.
      return <p className="nova-agent-notice">{SUSPEND_REASON_COPY[notice.reason].title}</p>;
  }
}

const MAX_MISSION_BUDGET_USD = 1_000;

function RaiseCap({ view, onResume }: { view: MissionView; onResume: (budgetUsd: number) => void }) {
  const id = useId();
  const current = view.budget?.budgetUsd ?? null;
  // French notation both ways: « 0,004 » proposed, « 0,50 $ » in the hint (never « 0.50 »).
  const [value, setValue] = useState(current === null ? "" : String(Math.min(MAX_MISSION_BUDGET_USD, current * 2)).replace(".", ","));
  const parsed = Number(value.replace(",", "."));
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed > (current ?? 0) && parsed <= MAX_MISSION_BUDGET_USD;
  return (
    <form
      className="nova-agent-raisecap"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onResume(parsed);
      }}
    >
      <label className="nv-field" htmlFor={id}>
        <span className="nv-field__label">{copy.mission.raiseCapLabel}</span>
        <input
          id={id}
          className="nv-field__control"
          inputMode="decimal"
          value={value}
          aria-invalid={!valid}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {!valid ? <p className="nova-note">{copy.mission.raiseCapInvalid(formatCost(current ?? 0) ?? "0 $")}</p> : null}
      <Button size="sm" variant="secondary" type="submit" disabled={!valid}>
        {copy.mission.raiseCap}
      </Button>
    </form>
  );
}

function SuspendedBanner({ view }: { view: MissionView }) {
  const resumeMission = useApp((state) => state.resumeMission);
  const stopMission = useApp((state) => state.stopMission);
  const toast = useToast();
  const suspended = view.suspended;
  if (!suspended || view.mission.state !== "suspended") return null;
  const reason = SUSPEND_REASON_COPY[suspended.reason];
  const act = (action: () => Promise<void>) =>
    action().catch((error: unknown) => toast.show(errorToast(error, copy.mission.actionFailed)));
  return (
    <Callout
      tone="warning"
      title={reason.title}
      className="nova-agent-suspended"
      action={
        <span className="nova-agent-suspended__actions">
          <Button size="sm" variant="primary" onClick={() => act(() => resumeMission(view.mission.id))}>
            {copy.mission.resume}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act(() => stopMission(view.mission.id))}>
            {copy.mission.stop}
          </Button>
        </span>
      }
    >
      <p>{suspended.detail ?? reason.detail}</p>
      {suspended.reason === "budget" ? (
        <RaiseCap view={view} onResume={(budgetUsd) => act(() => resumeMission(view.mission.id, budgetUsd))} />
      ) : null}
      {suspended.reason === "daily_budget" ? <p className="nova-note">{copy.mission.dailyCapHint}</p> : null}
    </Callout>
  );
}

export function MissionTimeline({ view }: { view: MissionView }) {
  const expert = useApp((state) => state.ui.displayMode === "expert");
  const entries = groupTimeline(view.items);
  return (
    <div className="nova-agent-timeline">
      <p className="nova-agent-goal">
        <span className="nova-agent-msg__author">{copy.agent.you}</span>
        <span>{view.mission.goal}</span>
      </p>
      <ol className="nova-agent-timeline__list" aria-label={copy.agent.timelineLabel}>
        {entries.map((entry) => {
          if (entry.kind === "group") {
            return (
              <li key={`group-${entry.items[0]?.id ?? ""}`}>
                <ToolGroupCard items={entry.items} expert={expert} />
              </li>
            );
          }
          const { item } = entry;
          return (
            <li key={`${item.kind}-${item.id}`}>
              {item.kind === "tool" ? <ToolCard item={item} expert={expert} /> : null}
              {item.kind === "message" ? <AgentMessage item={item} /> : null}
              {item.kind === "approval" ? <AgentApproval approval={item.approval} /> : null}
              {item.kind === "notice" ? <Notice item={item} /> : null}
            </li>
          );
        })}
      </ol>
      <SuspendedBanner view={view} />
      <EndCard view={view} />
    </div>
  );
}

// One tool call of the mission timeline (VISUAL.md §5.4): a folded one-line card, unfolded on demand
// (and by default when it failed, or for edits and commands in Expert). Everything shown comes from
// the call summary and its recorded `ToolDisplay`.
import { useState, type ReactNode } from "react";
import { Button, CitationChip, ToolCallCard, ToolCallGroup, type ToolCallStatus } from "@nova/ui";
import { isMcpToolName, parseMcpToolName, type ToolDisplay } from "@nova/shared";
import { fr } from "../../copy/fr";
import { PERMISSION_REASON_LABELS } from "../../copy/fr-atelier";
import { formatCost, formatInteger } from "../../lib/format";
import { useApp, useClient } from "../../state/context";
import { toolCategory, type ToolItem } from "../missions/timeline";

const copy = fr.atelier.timeline;
const OUTPUT_TAIL_LINES = 12;

export function formatDurationMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  return copy.duration(new Intl.NumberFormat("fr-FR", { maximumFractionDigits: seconds < 10 ? 1 : 0 }).format(seconds));
}

function tailLines(text: string, count: number): string {
  return text.split("\n").slice(-count).join("\n");
}

function verbOf(item: ToolItem): string {
  const { name } = item.call;
  if (isMcpToolName(name)) return copy.verbs.mcp;
  return copy.verbs[name];
}

/** "Lire `src/form.tsx:1-80`": verb, then the target in mono. */
function titleOf(item: ToolItem): ReactNode {
  const { call, display } = item;
  let target: string | null = call.path ?? call.host ?? (call.argv ? call.argv.join(" ") : null);
  if (display?.kind === "file_read") target = `${display.path}:${display.startLine}-${display.endLine}`;
  else if (display?.kind === "search") target = `"${display.pattern}"`;
  else if (display?.kind === "web_search") target = display.query;
  else if (display?.kind === "web_page") target = display.url;
  else if (display?.kind === "mcp") target = copy.mcpServer(display.server, display.tool);
  else if (isMcpToolName(call.name)) {
    const parsed = parseMcpToolName(call.name);
    target = parsed ? copy.mcpServer(parsed.serverSlug, parsed.toolSlug) : call.name;
  }
  const suffix =
    display?.kind === "file_change"
      ? ` +${display.additions} −${display.deletions}`
      : display?.kind === "search"
        ? ` · ${copy.results(display.matches.length)}`
        : "";
  return (
    <>
      <span className="nova-tool__verb">{verbOf(item)}</span>
      {/* A real space: the title is inline text (read aloud and copied as « Lire src/a.ts »). */}
      {target ? <> <code className="nova-tool__target">{target}</code></> : null}
      {suffix ? <span className="nova-tool__suffix">{suffix}</span> : null}
    </>
  );
}

function statusOf(item: ToolItem): ToolCallStatus {
  return item.state;
}

function DisplayBody({ display, item }: { display: ToolDisplay; item: ToolItem }) {
  const client = useClient();
  const revealFile = useApp((state) => state.revealFile);
  const openDoc = useApp((state) => state.openDoc);
  const missionId = useApp((state) => state.missions.selectedId);
  switch (display.kind) {
    case "text":
      return <pre className="nova-tool__pre">{display.text}</pre>;
    case "error":
      return (
        <p className="nova-tool__error">
          {display.message} <code>{display.code}</code>
        </p>
      );
    case "file_read":
      return (
        <p className="nova-tool__fact">
          {copy.lines(display.startLine, display.endLine)}
          {display.totalLines !== null ? ` / ${formatInteger(display.totalLines)}` : ""}{" "}
          <Button size="sm" variant="ghost" onClick={() => revealFile(display.path, display.startLine)}>
            {copy.openFile}
          </Button>
        </p>
      );
    case "file_list":
      return (
        <>
          <p className="nova-tool__fact">
            {copy.entries(display.entries.length)}
            {display.truncated ? ` · ${copy.truncated}` : ""}
          </p>
          <ul className="nova-tool__list">
            {display.entries.slice(0, 50).map((entry) => (
              <li key={entry.path}>
                <code>{entry.kind === "directory" ? `${entry.name}/` : entry.name}</code>
              </li>
            ))}
          </ul>
        </>
      );
    case "search":
      return (
        <>
          <p className="nova-tool__fact">
            {copy.results(display.matches.length)}
            {display.truncated ? ` · ${copy.truncated}` : ""}
          </p>
          <ul className="nova-tool__list">
            {display.matches.slice(0, 50).map((match) => (
              <li key={`${match.path}:${match.line}`}>
                <CitationChip
                  kind="file"
                  label={`${match.path.split("/").at(-1) ?? match.path}:${match.line}`}
                  title={match.path}
                  accessibleName={`${copy.openFile} ${match.path} ${match.line}`}
                  onOpen={() => revealFile(match.path, match.line)}
                />{" "}
                <code className="nova-tool__line">{match.lineText}</code>
              </li>
            ))}
          </ul>
        </>
      );
    case "file_change":
      return (
        <p className="nova-tool__fact">
          <code>{display.fromPath ? `${display.fromPath} → ${display.path}` : display.path}</code> +{display.additions} −
          {display.deletions}{" "}
          {missionId && display.change !== "deleted" ? (
            <Button size="sm" variant="ghost" onClick={() => openDoc({ kind: "diff", missionId })}>
              {copy.openDiff}
            </Button>
          ) : null}
          {display.change !== "deleted" ? (
            <Button size="sm" variant="ghost" onClick={() => revealFile(display.path, null)}>
              {copy.openFile}
            </Button>
          ) : null}
        </p>
      );
    case "command":
      return (
        <>
          <p className="nova-tool__fact">
            <code>{display.argv.join(" ")}</code> · {copy.exitCode(display.exitCode)}
            {display.signal ? ` (${display.signal})` : ""} · {copy.isolation(display.isolationLevel)}
            {formatDurationMs(display.durationMs) ? ` · ${formatDurationMs(display.durationMs)}` : ""}
          </p>
          {display.outputTail ? <pre className="nova-tool__pre">{tailLines(display.outputTail, OUTPUT_TAIL_LINES)}</pre> : null}
        </>
      );
    case "tests": {
      const n = (value: number | null) => (value === null ? fr.app.unknown : formatInteger(value));
      return (
        <p className="nova-tool__fact">
          {display.runner} · {copy.tests(n(display.passed), n(display.failed), n(display.skipped))} ·{" "}
          {copy.exitCode(display.exitCode)}
          {item.output ? null : ""}
        </p>
      );
    }
    case "git_status":
      return (
        <p className="nova-tool__fact">
          {display.status.available
            ? `${display.status.branch ?? fr.atelier.statusBar.detached} · ${copy.gitChanges(display.status.entries.length)}`
            : fr.app.unknown}
        </p>
      );
    case "git_diff":
      return (
        <>
          <pre className="nova-tool__pre">{display.patch}</pre>
          {display.truncated ? <p className="nova-note">{copy.truncated}</p> : null}
        </>
      );
    case "git_commit":
      return (
        <p className="nova-tool__fact">
          <code>{copy.commit(display.sha.slice(0, 10))}</code> {display.message}
        </p>
      );
    case "web_search":
      return (
        <>
          <p className="nova-tool__fact">
            {formatCost(display.costUsd) ? copy.webCost(formatCost(display.costUsd) ?? "") : copy.webCostUnknown}
          </p>
          <p className="nova-tool__subhead">{copy.sources}</p>
          <ol className="nova-tool__sources">
            {display.citations.map((citation) => (
              <li key={citation.url}>
                <CitationChip
                  kind="web"
                  label={hostOf(citation.url)}
                  title={citation.url}
                  accessibleName={`${citation.title} (${hostOf(citation.url)})`}
                  onOpen={() => void client.app.openExternal({ url: citation.url }).catch(() => undefined)}
                />{" "}
                <span>{citation.title}</span>
                {citation.snippet ? <span className="nova-tool__snippet">{citation.snippet}</span> : null}
              </li>
            ))}
          </ol>
        </>
      );
    case "web_page":
      return (
        <p className="nova-tool__fact">
          <code>{display.url}</code>
          {display.title ? ` · ${display.title}` : ""}
          {display.truncated ? ` · ${copy.truncated}` : ""}
        </p>
      );
    case "mcp":
      return (
        <>
          <p className="nova-tool__fact">
            {copy.mcpServer(display.server, display.tool)}
            {display.isError ? ` · ${copy.mcpError}` : ""}
          </p>
          {display.text ? <pre className="nova-tool__pre">{display.text}</pre> : null}
        </>
      );
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function ToolCard({ item, expert }: { item: ToolItem; expert: boolean }) {
  const category = toolCategory(item.call.name);
  const [expanded, setExpanded] = useState(
    item.state === "failed" || (expert && (category === "edit" || category === "terminal")),
  );
  const permission = item.permission;
  const showPermission = permission && permission.decision !== "allow";
  return (
    <ToolCallCard
      kind={category}
      title={titleOf(item)}
      status={statusOf(item)}
      statusLabel={copy.status[item.state]}
      duration={formatDurationMs(item.durationMs)}
      // Single focus: the agent panel header carries the orbit while the mission runs.
      orbit={false}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {showPermission ? <p className="nova-tool__fact">{copy.permission(PERMISSION_REASON_LABELS[permission.reason])}</p> : null}
      {expert ? (
        <>
          <p className="nova-tool__subhead">{copy.arguments}</p>
          <pre className="nova-tool__pre">{item.call.argumentsPreview}</pre>
        </>
      ) : null}
      {item.display ? (
        <>
          {expert ? <p className="nova-tool__subhead">{copy.result}</p> : null}
          <DisplayBody display={item.display} item={item} />
        </>
      ) : null}
      {item.output && item.state === "running" ? (
        <>
          <p className="nova-tool__subhead">{copy.output}</p>
          <pre className="nova-tool__pre" aria-live="off">
            {tailLines(item.output, OUTPUT_TAIL_LINES)}
          </pre>
        </>
      ) : null}
    </ToolCallCard>
  );
}

export function ToolGroupCard({ items, expert }: { items: ToolItem[]; expert: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const first = items[0];
  if (!first) return null;
  const category = toolCategory(first.call.name);
  const running = items.some((item) => item.state === "running");
  const waiting = items.some((item) => item.state === "waiting");
  const total = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
  const status: ToolCallStatus = running ? "running" : waiting ? "waiting" : items.every((item) => item.state === "succeeded") ? "succeeded" : (items.at(-1)?.state ?? "succeeded");
  const duration = formatDurationMs(total);
  return (
    <ToolCallGroup
      kind={category}
      label={`${copy.groupLabel(items.length, copy.categoryNouns[category])}${duration ? ` · ${duration}` : ""}`}
      status={status}
      statusLabel={copy.status[status]}
      orbit={false}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {items.map((item) => (
        <ToolCard key={item.id} item={item} expert={expert} />
      ))}
    </ToolCallGroup>
  );
}

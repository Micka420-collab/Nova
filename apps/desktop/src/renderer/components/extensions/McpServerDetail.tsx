import { useState } from "react";
import { Button, StatusPill, useToast, type BadgeTone } from "@nova/ui";
import type { McpServerState, McpServerView, McpTestResult, Workspace } from "@nova/shared";
import { fr } from "../../copy/fr";
import { MCP_STATE_LABELS } from "../../copy/fr-extensions";
import { errorToast } from "../../lib/errors";
import { useClient } from "../../state/context";
import { ConfirmDialog } from "../layout/ConversationDialogs";
import { McpToolTable } from "./McpToolTable";

const t = fr.extensions;

export const MCP_STATE_TONES: Record<McpServerState, BadgeTone> = {
  connected: "jade",
  starting: "jade",
  stopped: "neutral",
  disabled: "neutral",
  error: "danger",
  timeout: "amber",
};

function secretCount(view: McpServerView): number {
  const values = view.config.transport.type === "stdio" ? view.config.transport.env : view.config.transport.headers;
  return Object.values(values).filter((value) => value.kind === "secret_ref").length;
}

export function McpServerDetail({
  view,
  workspace,
  onChanged,
  onRemoved,
  onEdit,
}: {
  view: McpServerView;
  workspace: Workspace | null;
  onChanged: (view: McpServerView) => void;
  onRemoved: (serverId: string) => void;
  onEdit: () => void;
}) {
  const client = useClient();
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [test, setTest] = useState<McpTestResult | null>(null);
  const [journal, setJournal] = useState<string | null>(null);
  const [readingJournal, setReadingJournal] = useState(false);
  const [showArgs, setShowArgs] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { config, status } = view;
  const secrets = secretCount(view);

  async function runTest() {
    setTesting(true);
    try {
      const result = await client.mcp.test({ serverId: config.id });
      setTest(result);
      onChanged({ config, status: result.status });
      setRefreshKey((key) => key + 1);
      toast.show({ title: t.testDone, description: MCP_STATE_LABELS[result.status.state], tone: "info" });
    } catch (error) {
      toast.show(errorToast(error, t.testFailed));
    } finally {
      setTesting(false);
    }
  }

  async function readJournal() {
    setReadingJournal(true);
    try {
      setJournal(await client.mcp.logs({ serverId: config.id }));
    } catch (error) {
      toast.show(errorToast(error, t.journalFailed));
    } finally {
      setReadingJournal(false);
    }
  }

  async function toggle() {
    setToggling(true);
    try {
      const updated = await client.mcp.update({ serverId: config.id, enabled: !config.enabled });
      onChanged(updated);
      toast.show({ title: t.toggled(updated.config.enabled), tone: "success" });
    } catch (error) {
      toast.show(errorToast(error, t.toggleFailed));
    } finally {
      setToggling(false);
    }
  }

  async function remove() {
    try {
      await client.mcp.remove({ serverId: config.id });
      toast.show({ title: t.removed, tone: "success" });
      onRemoved(config.id);
    } catch (error) {
      toast.show(errorToast(error, t.removeFailed));
      throw error;
    }
  }

  return (
    <section className="nova-mcp-detail" aria-labelledby={`mcp-detail-${config.id}`}>
      <h2 id={`mcp-detail-${config.id}`} className="nova-mcp-detail__title">
        {config.name}
      </h2>
      <dl className="nova-facts">
        <dt>{t.status}</dt>
        <dd>
          <StatusPill tone={MCP_STATE_TONES[status.state]} active={status.state === "starting"}>
            {MCP_STATE_LABELS[status.state]}
          </StatusPill>
          <span>
            {t.tools(status.toolCount)}
            {status.protocolVersion ? ` · ${t.protocol(status.protocolVersion)}` : ""}
          </span>
        </dd>
        {status.lastError ? (
          <>
            <dt>{t.lastError}</dt>
            <dd className="nova-mcp-detail__error">{status.lastError}</dd>
          </>
        ) : null}
        <dt>{t.transport}</dt>
        <dd>
          {config.transport.type === "stdio" ? t.transportStdioLabel : t.transportHttpLabel} ·{" "}
          {config.scope === "workspace" ? t.scopeWorkspace : t.scopeGlobal}
        </dd>
        {config.transport.type === "stdio" ? (
          <>
            <dt>{t.command}</dt>
            <dd>
              <code>{config.transport.command}</code>
            </dd>
            <dt>{t.args}</dt>
            <dd>
              {config.transport.args.length === 0 ? (
                t.argsNone
              ) : showArgs ? (
                <code className="nova-mcp-detail__args">{config.transport.args.join(" ")}</code>
              ) : (
                <span>{t.argsHidden(config.transport.args.length)}</span>
              )}
              {config.transport.args.length > 0 ? (
                <Button size="sm" variant="ghost" aria-expanded={showArgs} onClick={() => setShowArgs((value) => !value)}>
                  {showArgs ? t.hideArgs : t.showArgs}
                </Button>
              ) : null}
            </dd>
          </>
        ) : (
          <>
            <dt>{t.url}</dt>
            <dd>
              <code>{config.transport.url}</code>
            </dd>
          </>
        )}
        {secrets > 0 ? (
          <>
            <dt>{t.rowSecret}</dt>
            <dd>{t.secrets(secrets)}</dd>
          </>
        ) : null}
      </dl>
      <div className="nova-mcp-detail__actions">
        <Button variant="primary" size="sm" loading={testing} disabled={!config.enabled} onClick={() => void runTest()}>
          {t.test}
        </Button>
        <Button variant="secondary" size="sm" loading={toggling} onClick={() => void toggle()}>
          {config.enabled ? t.disable : t.enable}
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {t.edit}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
          {t.remove}
        </Button>
      </div>
      <section className="nova-mcp-journal" aria-labelledby={`mcp-journal-${config.id}`}>
        <h3 id={`mcp-journal-${config.id}`} className="nova-mcp-subheading">
          {t.journal}
        </h3>
        {journal !== null || test ? (
          <>
            <p className="nova-note">{t.journalHint}</p>
            {(journal ?? test?.stderrTail ?? "").trim() ? (
              <pre className="nova-mcp-journal__output">{journal ?? test?.stderrTail}</pre>
            ) : (
              <p className="nova-note">{t.journalEmpty}</p>
            )}
          </>
        ) : (
          <p className="nova-note">{t.journalNone}</p>
        )}
        {config.transport.type === "stdio" ? (
          <Button size="sm" variant="ghost" loading={readingJournal} onClick={() => void readJournal()}>
            {t.journalRead}
          </Button>
        ) : null}
      </section>
      <McpToolTable serverId={config.id} workspace={workspace} refreshKey={refreshKey} initialTools={test?.tools ?? null} />
      {confirmRemove ? (
        <ConfirmDialog
          title={t.removeTitle(config.name)}
          description={t.removeDescription}
          confirmLabel={t.remove}
          onConfirm={remove}
          onClose={() => setConfirmRemove(false)}
        />
      ) : null}
    </section>
  );
}

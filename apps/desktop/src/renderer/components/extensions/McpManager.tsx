// Extensions › MCP servers (M3/M5, VISUAL.md §4.7): list, add/edit, test, journal, per-tool permissions.
// Everything shown comes from main (`mcp.*`); server descriptions are displayed as untrusted data.
import { useEffect, useState } from "react";
import { Button, Callout, EmptyState, Skeleton } from "@nova/ui";
import { NovaIpcError, type McpServerView } from "@nova/shared";
import { fr } from "../../copy/fr";
import { MCP_STATE_LABELS } from "../../copy/fr-extensions";
import { describeUiError, toUiError } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";
import { PlusIcon } from "../icons";
import { MCP_STATE_TONES, McpServerDetail } from "./McpServerDetail";
import { McpServerForm } from "./McpServerForm";
import { McpSources } from "./McpSources";

const t = fr.extensions;
const STATUS_REFRESH_MS = 250;

type ListState =
  | { status: "loading" }
  | { status: "ready"; servers: McpServerView[] }
  | { status: "unavailable" }
  | { status: "error"; message: string };

type FormTarget = { mode: "add" } | { mode: "edit"; server: McpServerView } | null;

function ServerRow({ view, selected, onSelect }: { view: McpServerView; selected: boolean; onSelect: () => void }) {
  const { config, status } = view;
  const tone = MCP_STATE_TONES[status.state];
  return (
    <button
      type="button"
      className={`nova-mcp-row nova-mcp-row--${tone}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className={`nova-mcp-row__dot nova-mcp-row__dot--${tone}`} aria-hidden />
      <span className="nova-mcp-row__name">{config.name}</span>
      <span className="nova-mcp-row__meta">
        {config.transport.type === "stdio" ? t.transportStdio : t.transportHttp} · {t.tools(status.toolCount)} ·{" "}
        {MCP_STATE_LABELS[status.state]} · {config.scope === "workspace" ? t.scopeWorkspace : t.scopeGlobal}
      </span>
      {status.state === "error" && status.lastError ? <span className="nova-mcp-row__error">{status.lastError}</span> : null}
    </button>
  );
}

export function McpManager() {
  const client = useClient();
  const workspace = useApp((state) => state.workspace.current);
  const workspaceId = workspace?.id ?? null;
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormTarget>(null);
  const [editVersion, setEditVersion] = useState(0);

  const [reload, setReload] = useState(0);
  // One key per read: a retry (reload) or another workspace starts a new one.
  const requestKey = `${workspaceId ?? ""}#${reload}`;

  useEffect(() => {
    let current = true;
    const scoped = requestKey.split("#")[0] ?? "";
    client.mcp
      .list({ workspaceId: scoped === "" ? null : scoped })
      .then((servers) => {
        if (current) setList({ status: "ready", servers });
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (error instanceof NovaIpcError && error.code === "unavailable") setList({ status: "unavailable" });
        else setList({ status: "error", message: describeUiError(toUiError(error)).title });
      });
    return () => {
      current = false;
    };
  }, [client, requestKey]);

  // Server status has no push channel: a tool call of a mission is when a server may have
  // connected, crashed or timed out, so the list is re-read then (debounced), and when the
  // manager is shown again. Without it a crashed server kept showing « connecté ».
  const shown = useApp((state) => state.ui.activeDoc === "extensions");
  const [wasShown, setWasShown] = useState(shown);
  if (shown !== wasShown) {
    setWasShown(shown);
    if (shown) setReload((value) => value + 1);
  }
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = client.missions.onEvent((event) => {
      if (event.type !== "tool.finished") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setReload((value) => value + 1), STATUS_REFRESH_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [client]);

  const retry = () => {
    setList({ status: "loading" });
    setReload((value) => value + 1);
  };

  const upsert = (view: McpServerView) =>
    setList((previous) => {
      if (previous.status !== "ready") return { status: "ready", servers: [view] };
      const exists = previous.servers.some((item) => item.config.id === view.config.id);
      return {
        status: "ready",
        servers: exists
          ? previous.servers.map((item) => (item.config.id === view.config.id ? view : item))
          : [...previous.servers, view],
      };
    });

  const servers = list.status === "ready" ? list.servers : [];
  const selected = servers.find((item) => item.config.id === selectedId) ?? null;
  const addButton = (
    <Button variant="primary" size="sm" icon={<PlusIcon size={14} />} onClick={() => setForm({ mode: "add" })}>
      {t.add}
    </Button>
  );

  return (
    <div className="nova-mcp">
      <header className="nova-mcp__header">
        <h1 className="nova-mcp__title">{t.serversHeading}</h1>
        {(list.status === "ready" && list.servers.length > 0) || list.status === "error" ? addButton : null}
      </header>
      {list.status === "unavailable" ? <Callout tone="info">{t.unavailable}</Callout> : null}
      {list.status === "error" ? (
        <Callout
          tone="danger"
          title={t.loadFailed}
          action={
            <Button size="sm" variant="secondary" onClick={retry}>
              {t.retry}
            </Button>
          }
        >
          <p>{list.message}</p>
        </Callout>
      ) : null}
      {list.status === "loading" ? (
        <div className="nova-mcp__loading" aria-busy="true">
          <p className="nv-visually-hidden">{t.loading}</p>
          <Skeleton height={44} radius={10} />
          <Skeleton height={44} radius={10} />
          <Skeleton height={44} radius={10} />
        </div>
      ) : null}
      {list.status === "ready" && servers.length === 0 ? (
        <EmptyState title={t.empty} description={t.emptyBody} action={addButton} />
      ) : null}
      {servers.length > 0 ? (
        <div className="nova-mcp__body">
          <ul className="nova-mcp__list" aria-label={t.listLabel}>
            {servers.map((view) => (
              <li key={view.config.id}>
                <ServerRow view={view} selected={view.config.id === selectedId} onSelect={() => setSelectedId(view.config.id)} />
              </li>
            ))}
          </ul>
          <div className="nova-mcp__detail">
            {selected ? (
              <McpServerDetail
                key={`${selected.config.id}:${editVersion}`}
                view={selected}
                workspace={workspace}
                onChanged={upsert}
                onRemoved={(id) => {
                  setSelectedId(null);
                  setList((previous) =>
                    previous.status === "ready"
                      ? { status: "ready", servers: previous.servers.filter((item) => item.config.id !== id) }
                      : previous,
                  );
                }}
                onEdit={() => setForm({ mode: "edit", server: selected })}
              />
            ) : (
              <p className="nova-note">{t.selectHint}</p>
            )}
          </div>
        </div>
      ) : null}
      {list.status === "ready" ? (
        <McpSources
          workspace={workspace}
          onAdded={(view) => {
            upsert(view);
            setSelectedId(view.config.id);
          }}
        />
      ) : null}
      {form ? (
        <McpServerForm
          server={form.mode === "edit" ? form.server : null}
          workspace={workspace}
          onClose={() => setForm(null)}
          onSaved={(view) => {
            upsert(view);
            setSelectedId(view.config.id);
            setEditVersion((version) => version + 1);
          }}
        />
      ) : null}
    </div>
  );
}

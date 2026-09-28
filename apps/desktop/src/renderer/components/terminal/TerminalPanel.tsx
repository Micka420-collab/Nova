// Dock terminal panel (FEATURES E13, VISUAL §4.5 and §5.6): session tabs, one xterm per session
// (all kept mounted so switching tabs keeps their screen), status line with the exit code,
// "Expliquer" actions, search. Agent sessions (J2-B L1) are read-only: a mission's background
// program can be taken over ("Prendre la main"); a mirror of the structured commands cannot, so
// `canTakeOver` (fed by the processes slice) decides where the button appears.
// Data never goes through invoke: each view gets its session's MessagePort from the port registry
// (a fresh `create` sends one; otherwise `terminal.attach` asks main for a new one + replay).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { Button, Callout, EmptyState, IconButton, OrbitIndicator, StatusPill } from "@nova/ui";
import { redactSecrets, type NovaApi, type NovaPortRegistry, type TerminalSession } from "@nova/shared";
import type { TerminalStore } from "../../state/terminal-slice";
import { processesCopy } from "../../copy/fr-processes";
import { terminalCopy as copy } from "./copy";
import type { TerminalExit } from "./terminal-client";
import { documentColorScheme, type TerminalColorScheme } from "./terminal-theme";
import { TerminalView, type RendererIssue, type TerminalHandle } from "./TerminalView";

/** Context of an "Expliquer" request, already redacted and bounded (POWER_UX §5.4: 200 lines / 8 KB). */
export interface TerminalExplainRequest {
  sessionId: string;
  source: "selection" | "failure";
  text: string;
  exitCode: number | null;
  shell: string;
  cwd: string;
  missionId: string | null;
}

export interface TerminalPanelProps {
  api: NovaApi["terminal"];
  ports: NovaPortRegistry;
  store: TerminalStore;
  workspaceId: string;
  /** Workspace-relative directory of new sessions ("" = root). */
  cwd?: string;
  /** Companion/agent hook (N3). Never called automatically: only on a user click or shortcut. */
  onExplain?(request: TerminalExplainRequest): void;
  /** Links in the output; the lead routes them through app.openExternal and its allowlist. */
  onOpenLink(uri: string): void;
  colorScheme?: TerminalColorScheme;
  screenReaderMode?: boolean;
  highContrast?: boolean;
  reducedMotion?: boolean;
  /**
   * Running agent sessions whose program accepts input once taken over (background processes:
   * `interactiveAgentSessions` of the processes slice). Default: every running agent session.
   */
  canTakeOver?(session: TerminalSession): boolean;
}

const EXPLAIN_LINES = 200;
const EXPLAIN_CHARS = 8_192;

function bounded(text: string): string {
  const lines = text.split("\n");
  const tail = lines.slice(-EXPLAIN_LINES).join("\n");
  return redactSecrets(tail.length > EXPLAIN_CHARS ? tail.slice(tail.length - EXPLAIN_CHARS) : tail);
}

function statusOf(session: TerminalSession): { label: string; tone: "neutral" | "jade" | "danger" } {
  if (session.state === "running") return { label: copy.running, tone: "jade" };
  if (session.exitCode === null) return { label: copy.exitedSignal, tone: "neutral" };
  if (session.exitCode === 0) return { label: copy.exitedOk, tone: "neutral" };
  return { label: copy.exitedCode(session.exitCode), tone: "danger" };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TerminalPanel(props: TerminalPanelProps) {
  const { api, ports, store, workspaceId } = props;
  const sessions = useStore(store, (state) => state.sessions);
  const activeId = useStore(store, (state) => state.activeId);
  const status = useStore(store, (state) => state.status);
  const error = useStore(store, (state) => state.error);
  const handles = useRef(new Map<string, TerminalHandle>());
  const freshPorts = useRef(new Set<string>());
  const tabList = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(false);
  const [rendererIssue, setRendererIssue] = useState<RendererIssue | null>(null);
  const [portErrors, setPortErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [generation, setGeneration] = useState<Record<string, number>>({});
  const colorScheme = props.colorScheme ?? documentColorScheme();

  const load = useCallback(() => {
    store.getState().setStatus("loading");
    api.list({ workspaceId }).then(
      (list) => {
        store.getState().setSessions(list);
        store.getState().setStatus("ready");
      },
      (reason: unknown) => store.getState().setStatus("error", message(reason)),
    );
  }, [api, store, workspaceId]);

  useEffect(load, [load]);

  // Agent sessions appear as soon as a mission opens them; owner changes and exits follow.
  // User sessions are added by `create` itself (its port must be registered before the view mounts).
  useEffect(
    () =>
      api.onEvent((event) => {
        const { session } = event;
        if (session.workspaceId !== workspaceId) return;
        const known = store.getState().sessions.some((item) => item.id === session.id);
        if (event.type === "session.created" ? session.owner === "agent" : known) store.getState().upsertSession(session);
      }),
    [api, store, workspaceId],
  );

  const acquirePort = async (sessionId: string): Promise<MessagePort> => {
      if (freshPorts.current.delete(sessionId)) return ports.take("terminal", sessionId);
      // Reattach (window reload, remount): main sends a new port and the host replays the scrollback.
      const port = ports.take("terminal", sessionId);
      try {
        await api.attach({ sessionId });
      } catch (reason) {
        port.then((late) => late.close(), () => {});
        throw reason;
      }
      return port;
  };

  const create = async (): Promise<void> => {
    try {
      const session = await api.create({ workspaceId, cwd: props.cwd ?? "", cols: 100, rows: 30 });
      freshPorts.current.add(session.id);
      store.getState().upsertSession(session);
      store.getState().select(session.id);
      store.getState().setStatus("ready");
    } catch (reason) {
      store.getState().setStatus("error", message(reason));
    }
  };

  const close = async (sessionId: string): Promise<void> => {
      setConfirmClose(null);
      try {
        await api.kill({ sessionId });
        store.getState().removeSession(sessionId);
      } catch (reason) {
        setPortErrors((current) => ({ ...current, [sessionId]: message(reason) }));
      }
  };

  const requestClose = (session: TerminalSession): void => {
    if (session.owner === "agent" && session.state === "running") setConfirmClose(session.id);
    else void close(session.id);
  };

  const onExit = (session: TerminalSession, exit: TerminalExit): void => {
    store.getState().markExited(session.id, exit.exitCode);
    setAnnouncement(copy.exitAnnouncement(exit.exitCode));
  };

  const explain = (session: TerminalSession, source: TerminalExplainRequest["source"]): void => {
    const handle = handles.current.get(session.id);
    if (!handle || !props.onExplain) return;
    const text = source === "selection" ? handle.selection() : handle.tail(EXPLAIN_LINES, EXPLAIN_CHARS);
    if (!text.trim()) return;
    props.onExplain({
      sessionId: session.id,
      source,
      text: bounded(text),
      exitCode: session.exitCode,
      shell: session.shell,
      cwd: session.cwd,
      missionId: session.missionId,
    });
  };

  const takeOver = async (sessionId: string): Promise<void> => {
    try {
      store.getState().upsertSession(await api.takeOver({ sessionId }));
      handles.current.get(sessionId)?.focus();
    } catch (reason) {
      setPortErrors((current) => ({ ...current, [sessionId]: message(reason) }));
    }
  };

  const reconnect = (sessionId: string): void => {
    setPortErrors(({ [sessionId]: _dropped, ...rest }) => rest);
    setGeneration((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
  };

  const select = (sessionId: string, focus: boolean): void => {
    store.getState().select(sessionId);
    setSelection(false);
    if (focus) requestAnimationFrame(() => handles.current.get(sessionId)?.focus());
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = sessions.findIndex((s) => s.id === activeId);
    const next = sessions[(index + (event.key === "ArrowRight" ? 1 : -1) + sessions.length) % sessions.length];
    if (!next) return;
    event.preventDefault();
    store.getState().select(next.id);
    tabList.current?.querySelector<HTMLElement>(`[data-session="${next.id}"]`)?.focus();
  };

  const find = (direction: "next" | "previous"): void => {
    const handle = activeId ? handles.current.get(activeId) : undefined;
    if (!handle || !query) return;
    if (direction === "next") handle.findNext(query);
    else handle.findPrevious(query);
  };

  const closeFind = (): void => {
    setFindOpen(false);
    if (activeId) {
      handles.current.get(activeId)?.clearSearch();
      handles.current.get(activeId)?.focus();
    }
  };

  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const takeOverable = (session: TerminalSession): boolean => props.canTakeOver?.(session) ?? true;

  if (status === "error" && sessions.length === 0) {
    return (
      <section className="nv-terminal-panel" aria-label={copy.panelLabel}>
        <Callout tone="danger" title={copy.unavailableTitle} action={<Button onClick={load}>{copy.retry}</Button>}>
          {error}
        </Callout>
      </section>
    );
  }

  return (
    <section className="nv-terminal-panel" aria-label={copy.panelLabel}>
      <div className="nv-terminal-bar">
        <div
          className="nv-terminal-tabs"
          role="tablist"
          tabIndex={-1}
          aria-label={copy.tabsLabel}
          ref={tabList}
          onKeyDown={onTabKey}
        >
          {sessions.map((session) => {
            const state = statusOf(session);
            return (
              <button
                key={session.id}
                type="button"
                role="tab"
                id={`nv-terminal-tab-${session.id}`}
                aria-controls={`nv-terminal-tabpanel-${session.id}`}
                aria-selected={session.id === activeId}
                tabIndex={session.id === activeId ? 0 : -1}
                data-session={session.id}
                className="nv-terminal-tab"
                onClick={() => select(session.id, true)}
              >
                {session.owner === "agent" ? (
                  <OrbitIndicator size={12} active={session.state === "running"} label={copy.nomi} />
                ) : (
                  <span className={`nv-terminal-dot nv-terminal-dot--${state.tone}`} aria-hidden="true" />
                )}
                <span className="nv-terminal-tab-title">{session.title}</span>
                <span className="nv-visually-hidden">{`, ${state.label}`}</span>
              </button>
            );
          })}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void create()}>
          {copy.newSession}
        </Button>
      </div>

      {/* One line: in a 240 px dock a callout left no room for the terminal itself. */}
      {rendererIssue ? (
        <p className="nv-terminal-notice" role="note" title={copy.degraded}>
          {copy.degraded}
        </p>
      ) : null}

      {active ? (
        <div className="nv-terminal-status">
          <span className="nv-terminal-cwd" title={active.cwd || "."}>
            {active.shell} · {active.cwd || "."}
          </span>
          <StatusPill tone={statusOf(active).tone} active={active.state === "running"}>
            {statusOf(active).label}
          </StatusPill>
          <span className="nv-terminal-actions">
            {active.state === "exited" && (active.exitCode ?? 0) !== 0 && props.onExplain ? (
              <Button size="sm" variant="secondary" onClick={() => explain(active, "failure")}>
                {copy.explainError}
              </Button>
            ) : null}
            {selection && props.onExplain ? (
              <Button size="sm" variant="ghost" onClick={() => explain(active, "selection")}>
                {copy.explainSelection}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setFindOpen(true)}>
              {copy.find}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => handles.current.get(active.id)?.clear()}>
              {copy.clear}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => requestClose(active)}>
              {copy.close}
            </Button>
          </span>
        </div>
      ) : null}

      {active && confirmClose === active.id ? (
        <Callout
          tone="warning"
          className="nv-terminal-callout"
          action={
            <span className="nv-terminal-actions">
              <Button size="sm" variant="danger" onClick={() => void close(active.id)}>
                {copy.closeConfirm}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClose(null)}>
                {copy.cancel}
              </Button>
            </span>
          }
        >
          {copy.closeAgentConfirm}
        </Callout>
      ) : null}

      {active && active.owner === "agent" ? (
        <Callout
          tone="info"
          className="nv-terminal-callout"
          action={
            active.state === "running" && takeOverable(active) ? (
              <Button size="sm" onClick={() => void takeOver(active.id)}>
                {copy.takeOver}
              </Button>
            ) : undefined
          }
        >
          {active.state === "running" && !takeOverable(active) ? processesCopy.terminal.mirrorNote : copy.agentReadOnly}
        </Callout>
      ) : null}

      {findOpen ? (
        <search className="nv-terminal-find">
          <input
            ref={findInput}
            className="nv-field__control nv-terminal-find-input"
            aria-label={copy.findLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") find(event.shiftKey ? "previous" : "next");
              else if (event.key === "Escape") closeFind();
            }}
          />
          <IconButton aria-label={copy.findPrevious} size="sm" icon={<span aria-hidden="true">↑</span>} onClick={() => find("previous")} />
          <IconButton aria-label={copy.findNext} size="sm" icon={<span aria-hidden="true">↓</span>} onClick={() => find("next")} />
          <IconButton aria-label={copy.findClose} size="sm" icon={<span aria-hidden="true">×</span>} onClick={closeFind} />
        </search>
      ) : null}

      {status === "error" && error ? <Callout tone="danger">{error}</Callout> : null}

      <div className="nv-terminal-views">
        {sessions.length === 0 && status !== "loading" ? (
          <EmptyState
            headingLevel={3}
            title={copy.emptyTitle}
            description={copy.emptyDetail}
            action={<Button onClick={() => void create()}>{copy.newSession}</Button>}
          />
        ) : null}
        {sessions.map((session, index) => (
          <div
            key={`${session.id}:${generation[session.id] ?? 0}`}
            className="nv-terminal-tabpanel"
            role="tabpanel"
            id={`nv-terminal-tabpanel-${session.id}`}
            aria-labelledby={`nv-terminal-tab-${session.id}`}
            hidden={session.id !== activeId}
          >
            {portErrors[session.id] ? (
              <Callout
                tone="danger"
                action={
                  <Button size="sm" onClick={() => reconnect(session.id)}>
                    {copy.reconnect}
                  </Button>
                }
              >
                {copy.portLost} {portErrors[session.id]}
              </Callout>
            ) : null}
            <TerminalView
              session={session}
              label={copy.sessionRegion(index + 1, session.shell)}
              hidden={session.id !== activeId}
              readOnly={session.owner !== "user"}
              colorScheme={colorScheme}
              screenReaderMode={props.screenReaderMode ?? false}
              highContrast={props.highContrast ?? false}
              reducedMotion={props.reducedMotion ?? false}
              acquirePort={() => acquirePort(session.id)}
              onResize={(cols, rows) => void api.resize({ sessionId: session.id, cols, rows }).catch(() => {})}
              onExit={(exit) => onExit(session, exit)}
              onPortError={(text) => setPortErrors((current) => ({ ...current, [session.id]: text }))}
              onSelectionChange={setSelection}
              onOpenLink={props.onOpenLink}
              onLeave={() => tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()}
              onFind={() => setFindOpen(true)}
              onExplain={() => explain(session, session.state === "exited" ? "failure" : "selection")}
              onRendererIssue={setRendererIssue}
              handleRef={(handle) => {
                if (handle) handles.current.set(session.id, handle);
                else handles.current.delete(session.id);
              }}
            />
          </div>
        ))}
      </div>

      <div className="nv-visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </section>
  );
}

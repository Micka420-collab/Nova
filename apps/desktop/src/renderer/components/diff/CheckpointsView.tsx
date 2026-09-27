// "Points de reprise" document (A10, UX.md §5.13): restore one file or go back to a point. Main
// never overwrites a file changed since: a conflict is shown, and nothing is written.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Callout, Dialog, EmptyState, Skeleton, useToast } from "@nova/ui";
import type { Checkpoint, CheckpointFile, RestoreAllResult } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeUiError, errorToast, toUiError, type UiError } from "../../lib/errors";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp, useClient } from "../../state/context";

const copy = fr.diff.checkpoints;
const LIST_LIMIT = 200;

type Load = { status: "loading" } | { status: "ready"; items: Checkpoint[] } | { status: "error"; error: UiError };

function fileChange(file: CheckpointFile): "created" | "modified" | "deleted" {
  if (file.beforeHash === null) return "created";
  if (file.afterHash === null) return "deleted";
  return "modified";
}

const timeFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function CheckpointsView({ missionId }: { missionId: string | null }) {
  const client = useClient();
  const toast = useToast();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const revealFile = useApp((state) => state.revealFile);
  const refreshGit = useApp((state) => state.refreshGit);
  const now = useNow(60_000);
  const [keyed, setKeyed] = useState<{ key: string; load: Load } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Checkpoint | null>(null);
  const [outcome, setOutcome] = useState<{ checkpointId: string; result: RestoreAllResult } | null>(null);

  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  // A loaded answer belongs to one request; an older one means a load is in flight.
  const requestKey = `${workspaceId ?? ""}|${missionId ?? ""}|${version}`;
  const load: Load = keyed?.key === requestKey ? keyed.load : { status: "loading" };

  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    client.checkpoints
      .list({ workspaceId, missionId, limit: LIST_LIMIT })
      .then((items) => {
        if (current) setKeyed({ key: requestKey, load: { status: "ready", items: items.toSorted((a, b) => b.createdAt - a.createdAt) } });
      })
      .catch((error: unknown) => {
        if (current) setKeyed({ key: requestKey, load: { status: "error", error: toUiError(error) } });
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, missionId, requestKey]);

  if (!workspaceId) {
    return (
      <div className="nova-checkpoints">
        <EmptyState title={copy.title} description={copy.needsWorkspace} headingLevel={2} />
      </div>
    );
  }

  async function restoreFile(checkpoint: Checkpoint, path: string) {
    const key = `${checkpoint.id}:${path}`;
    setBusy(key);
    try {
      const result = await client.checkpoints.restoreFile({ checkpointId: checkpoint.id, path });
      if (result.status === "conflict") setConflict(path);
      else {
        toast.show({ title: copy.restored(path), tone: "success" });
        void refreshGit();
        refresh();
      }
    } catch (error) {
      toast.show(errorToast(error, copy.restoreFailed));
    } finally {
      setBusy(null);
    }
  }

  async function restoreAll(checkpoint: Checkpoint) {
    setConfirm(null);
    setBusy(checkpoint.id);
    try {
      const result = await client.checkpoints.restoreAll({ checkpointId: checkpoint.id });
      setOutcome({ checkpointId: checkpoint.id, result });
      void refreshGit();
      refresh();
    } catch (error) {
      toast.show(errorToast(error, copy.restoreFailed));
    } finally {
      setBusy(null);
    }
  }

  let body;
  if (load.status === "loading") {
    body = (
      <div aria-busy="true">
        <p className="nv-visually-hidden">{copy.loading}</p>
        <Skeleton height={56} radius={12} />
        <Skeleton height={56} radius={12} />
      </div>
    );
  } else if (load.status === "error") {
    body = (
      <Callout
        tone="danger"
        title={copy.failed}
        action={
          <Button size="sm" variant="secondary" onClick={refresh}>
            {fr.app.retry}
          </Button>
        }
      >
        <p>{describeUiError(load.error).title}</p>
      </Callout>
    );
  } else if (load.items.length === 0) {
    body = <EmptyState title={copy.empty} description={copy.emptyBody} headingLevel={3} />;
  } else {
    body = (
      <ol className="nova-checkpoints__list">
        {load.items.map((checkpoint) => {
          const restored = outcome?.checkpointId === checkpoint.id ? outcome.result : null;
          const conflicts = restored?.results.filter((item) => item.status === "conflict") ?? [];
          return (
            <li key={checkpoint.id} className="nova-checkpoints__item">
              <header className="nova-checkpoints__header">
                <h3 className="nova-checkpoints__label">{checkpoint.label}</h3>
                <Badge tone="neutral">{copy.reason[checkpoint.reason]}</Badge>
                <time className="nova-checkpoints__time" dateTime={new Date(checkpoint.createdAt).toISOString()} title={timeFormat.format(checkpoint.createdAt)}>
                  {formatRelative(checkpoint.createdAt, now)}
                </time>
                <span className="nova-checkpoints__count">{copy.files(checkpoint.files.length)}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === checkpoint.id}
                  disabled={busy !== null || checkpoint.files.length === 0}
                  onClick={() => setConfirm(checkpoint)}
                >
                  {copy.restoreAll}
                </Button>
              </header>
              <ul className="nova-checkpoints__files">
                {checkpoint.files.map((file) => (
                  <li key={file.path} className="nova-checkpoints__file">
                    <code>{file.path}</code>
                    <span className="nova-checkpoints__change">{copy.fileChange[fileChange(file)]}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={copy.restoreFileNamed(file.path)}
                      loading={busy === `${checkpoint.id}:${file.path}`}
                      disabled={busy !== null}
                      onClick={() => void restoreFile(checkpoint, file.path)}
                    >
                      {copy.restoreFile}
                    </Button>
                  </li>
                ))}
              </ul>
              {restored ? (
                <Callout tone={conflicts.length > 0 ? "warning" : "success"} title={copy.restoreAllDone(restored.results.length - conflicts.length, conflicts.length)}>
                  {restored.safetyCheckpointId ? <p>{copy.safety}</p> : null}
                  {conflicts.length > 0 ? (
                    <ul>
                      {conflicts.map((item) => (
                        <li key={item.path}>{copy.conflictItem(item.path)}</li>
                      ))}
                    </ul>
                  ) : null}
                </Callout>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div className="nova-checkpoints">
      <h2 className="nova-checkpoints__title">{copy.title}</h2>
      <section aria-label={copy.label}>{body}</section>

      <Dialog
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title={copy.conflictTitle}
        description={copy.conflictBody}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConflict(null)}>
              {copy.keepMine}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const path = conflict;
                setConflict(null);
                if (path) revealFile(path, null);
              }}
            >
              {copy.compare}
            </Button>
          </>
        }
      >
        {conflict ? <code>{conflict}</code> : null}
      </Dialog>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? copy.restoreAllTitle(confirm.label) : ""}
        description={confirm ? copy.restoreAllBody(confirm.files.length) : undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {fr.app.cancel}
            </Button>
            <Button variant="primary" onClick={() => confirm && void restoreAll(confirm)}>
              {copy.restoreAllConfirm}
            </Button>
          </>
        }
      >
        {confirm ? (
          <ul className="nova-checkpoints__confirm">
            {confirm.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code> — {copy.fileChange[fileChange(file)]}
              </li>
            ))}
          </ul>
        ) : null}
      </Dialog>
    </div>
  );
}

// Loading / error / unavailable states shared by the atelier settings sections.
import { useEffect, useRef, useState } from "react";
import { Button, Callout, Skeleton } from "@nova/ui";
import type { PermissionRequest } from "@nova/shared";
import { fr, IPC_ERROR_COPY } from "../../copy/fr";
import { describeUiError, toUiError, type UiError } from "../../lib/errors";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: UiError };

/** Runs `load` whenever `key` changes (or on retry); answers for an older key are dropped. */
export function useLoaded<T>(key: string | null, load: () => Promise<T>): [Loaded<T>, () => void, (data: T) => void] {
  const [attempt, setAttempt] = useState(0);
  const token = `${key ?? ""}#${attempt}`;
  const [state, setState] = useState<{ token: string; value: Loaded<T> } | null>(null);
  // `load` changes identity every render; only the key and explicit retries trigger a reload.
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  useEffect(() => {
    let current = true;
    loader.current().then(
      (data) => current && setState({ token, value: { status: "ready", data } }),
      (error: unknown) => current && setState({ token, value: { status: "error", error: toUiError(error) } }),
    );
    return () => {
      current = false;
    };
  }, [token]);
  const value: Loaded<T> = state?.token === token ? state.value : { status: "loading" };
  return [value, () => setAttempt((n) => n + 1), (data) => setState({ token, value: { status: "ready", data } })];
}

export function SectionLoading({ label }: { label?: string }) {
  return (
    <div className="nova-aset-loading" aria-busy="true">
      {label ? <p className="nv-visually-hidden">{label}</p> : null}
      <Skeleton height={36} radius={10} />
      <Skeleton height={36} radius={10} />
      <Skeleton height={36} radius={10} />
    </div>
  );
}

/** A failed load: `unavailable` is a capability not wired yet (info), anything else is an error. */
export function SectionError({ error, onRetry }: { error: UiError; onRetry: () => void }) {
  if (error.code === "unavailable") return <Callout tone="info">{IPC_ERROR_COPY.unavailable}</Callout>;
  return (
    <Callout
      tone="danger"
      title={fr.atelierSettings.common.loadFailed}
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {fr.atelierSettings.common.retry}
        </Button>
      }
    >
      <p>{describeUiError(error).title}</p>
    </Callout>
  );
}

const DATE_TIME = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function formatDateTime(at: number): string {
  return DATE_TIME.format(at);
}

/** What an approval is about, as the user reads it: path, host or command. */
export function approvalTarget(request: Pick<PermissionRequest, "path" | "host" | "argv">): string {
  if (request.path) return request.path;
  if (request.host) return request.host;
  if (request.argv && request.argv.length > 0) return request.argv.join(" ");
  return "—";
}

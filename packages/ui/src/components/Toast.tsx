import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../cx";
import { IconButton } from "./Button";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss delay; `null` keeps the toast until dismissed. Default: 6 s, persistent for danger. */
  durationMs?: number | null;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show: (toast: ToastOptions) => string;
  dismiss: (id: string) => void;
}

interface ToastRecord extends ToastOptions {
  id: string;
}

const DEFAULT_DURATION_MS = 6000;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (!api) throw new Error("useToast() must be called inside <Toaster>");
  return api;
}

export interface ToasterProps {
  children: ReactNode;
  /** Accessible name of the notifications region. */
  label?: string;
  dismissLabel?: string;
  /** Extra class for the region (fixed to the bottom-right corner by default). */
  className?: string;
}

/** Provides `useToast()` and renders the polite live region the toasts are announced from. */
export function Toaster({
  children,
  label = "Notifications",
  dismissLabel = "Fermer la notification",
  className,
}: ToasterProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback((toast: ToastOptions) => {
    nextId.current += 1;
    const id = `toast-${nextId.current}`;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <section className={cx("nv-toaster", className)} aria-label={label}>
        <ol className="nv-toaster__list" aria-live="polite" aria-relevant="additions text">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} dismissLabel={dismissLabel} onDismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext>
  );
}

function ToastItem({
  toast,
  dismissLabel,
  onDismiss,
}: {
  toast: ToastRecord;
  dismissLabel: string;
  onDismiss: (id: string) => void;
}) {
  const tone = toast.tone ?? "info";
  const duration = toast.durationMs === undefined ? (tone === "danger" ? null : DEFAULT_DURATION_MS) : toast.durationMs;
  const remaining = useRef(duration);
  const [paused, setPaused] = useState(false);

  // Hover or focus pauses the countdown (WCAG 2.2.1); the remaining time resumes afterwards.
  useEffect(() => {
    const left = remaining.current;
    if (paused || left === null) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), left);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, left - (Date.now() - startedAt));
    };
  }, [paused, onDismiss, toast.id]);

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hover/focus only pause the timer
    <li
      className={cx("nv-toast", `nv-toast--${tone}`)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="nv-toast__marker" aria-hidden />
      <div className="nv-toast__content">
        <p className="nv-toast__title">{toast.title}</p>
        {toast.description ? <p className="nv-toast__description">{toast.description}</p> : null}
      </div>
      <IconButton
        aria-label={dismissLabel}
        icon={<X size={16} aria-hidden />}
        size="sm"
        onClick={() => onDismiss(toast.id)}
      />
    </li>
  );
}

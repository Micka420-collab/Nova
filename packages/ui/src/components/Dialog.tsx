import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../cx";
import { IconButton } from "./Button";

export interface DialogProps {
  open: boolean;
  /** Called for the close button, Escape, and any native close; the parent owns `open`. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  closeLabel?: string;
  className?: string;
}

/** Modal built on native <dialog>: top layer, focus trap and inert background come from the platform. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  closeLabel = "Fermer",
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // Layout effect: open/close in the same frame as the content change, and give focus back to the
  // element that opened the dialog.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx("nv-dialog", `nv-dialog--${size}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // The close event is queued: ignore one that arrives after the dialog was shown again (e.g. the
        // StrictMode effect replay) or after the parent already closed it.
        if (open && !ref.current?.open) onClose();
      }}
    >
      {open ? (
        <>
          <header className="nv-dialog__header">
            <h2 id={titleId} className="nv-dialog__title">
              {title}
            </h2>
            <IconButton aria-label={closeLabel} icon={<X size={18} aria-hidden />} size="sm" onClick={onClose} />
          </header>
          {description ? (
            <p id={descriptionId} className="nv-dialog__description">
              {description}
            </p>
          ) : null}
          {children ? <div className="nv-dialog__body">{children}</div> : null}
          {footer ? <footer className="nv-dialog__footer">{footer}</footer> : null}
        </>
      ) : null}
    </dialog>
  );
}

import type { ComponentPropsWithRef, ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cx } from "../cx";

export type CalloutTone = "info" | "success" | "warning" | "danger";

export interface CalloutProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
  tone?: CalloutTone;
  title?: ReactNode;
  /** Follow-up control (retry, open settings...) shown under the message. */
  action?: ReactNode;
}

const ICONS: Record<CalloutTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/** Inline message. Danger callouts are announced immediately (role alert), others politely (status). */
export function Callout({ tone = "info", title, action, className, children, ...rest }: CalloutProps) {
  const Icon = ICONS[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      {...rest}
      className={cx("nv-callout", `nv-callout--${tone}`, className)}
    >
      <Icon className="nv-callout__icon" aria-hidden size={18} strokeWidth={2} />
      <div className="nv-callout__content">
        {title ? <p className="nv-callout__title">{title}</p> : null}
        {children ? <div className="nv-callout__body">{children}</div> : null}
        {action ? <div className="nv-callout__action">{action}</div> : null}
      </div>
    </div>
  );
}

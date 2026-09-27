import type { ReactNode } from "react";
import { cx } from "../cx";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** Illustration or icon (decorative). */
  icon?: ReactNode;
  /** The real next step; an empty state never ends in a dead end. */
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

export function EmptyState({ title, description, icon, action, headingLevel = 2, className }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className={cx("nv-empty", className)}>
      {icon ? (
        <div className="nv-empty__icon" aria-hidden>
          {icon}
        </div>
      ) : null}
      <Heading className="nv-empty__title">{title}</Heading>
      {description ? <p className="nv-empty__description">{description}</p> : null}
      {action ? <div className="nv-empty__action">{action}</div> : null}
    </section>
  );
}

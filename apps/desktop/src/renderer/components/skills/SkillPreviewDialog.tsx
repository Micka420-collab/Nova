// L3 — what the user reads BEFORE installing or enabling a skill (and when viewing one): the full
// SKILL.md, its files, what it declares (information only, never a grant) and the warnings.
// Everything shown is the skill's own text, rendered as plain text.
import { Button, Callout, Dialog, Skeleton } from "@nova/ui";
import type { SkillDetail, SkillPreview } from "@nova/shared";
import { SKILL_FILE_KIND_LABELS, SKILL_SCOPE_LABELS, SKILL_WARNING_COPY, skillsCopy } from "../../copy/fr-skills";
import { formatInteger } from "../../lib/format";
import { skillLabel } from "./skill-errors";

const copy = skillsCopy.preview;

export type SkillDialogMode = "install" | "enable" | "view";

export type SkillDialogState =
  | { status: "loading" }
  | { status: "ready"; detail: SkillDetail | SkillPreview }
  | { status: "error"; message: string };

function titleOf(mode: SkillDialogMode): string {
  if (mode === "install") return copy.installTitle;
  if (mode === "enable") return copy.enableTitle;
  return copy.viewTitle;
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <span>{copy.none}</span>;
  return (
    <span className="nova-skill-preview__chips">
      {items.map((item) => (
        <code key={item}>{item}</code>
      ))}
    </span>
  );
}

function Body({ detail, mode }: { detail: SkillDetail | SkillPreview; mode: SkillDialogMode }) {
  const { meta } = detail;
  const replaces = "replaces" in detail ? detail.replaces : null;
  return (
    <div className="nova-skill-preview">
      <p className="nova-skill-preview__meta">
        <strong>{skillLabel(meta)}</strong> · {mode === "install" ? copy.toInstall : SKILL_SCOPE_LABELS[meta.scope]} · {copy.version(meta.version)}
      </p>
      <p className="nova-skill-preview__description">{meta.description}</p>
      {mode === "install" && replaces ? <Callout tone="warning">{copy.replaces}</Callout> : null}
      <section aria-label={copy.declaredHeading}>
        <h3 className="nova-skill-preview__heading">{copy.declaredHeading}</h3>
        <p className="nova-note">{copy.declaredNote}</p>
        <dl className="nova-facts">
          <dt>{copy.tools}</dt>
          <dd>
            <List items={meta.declared.tools} />
          </dd>
          <dt>{copy.hosts}</dt>
          <dd>
            <List items={meta.declared.hosts} />
          </dd>
          <dt>{copy.scripts}</dt>
          <dd>
            <List items={meta.declared.scripts} />
          </dd>
        </dl>
      </section>
      {detail.warnings.length > 0 ? (
        <section aria-label={copy.warningsHeading}>
          <h3 className="nova-skill-preview__heading">{copy.warningsHeading}</h3>
          <ul className="nova-skill-preview__warnings">
            {detail.warnings.map((warning, index) => (
              <li key={`${warning.code}:${warning.subject ?? ""}:${index}`}>{SKILL_WARNING_COPY[warning.code](warning.subject)}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label={copy.filesHeading(detail.files.length)}>
        <h3 className="nova-skill-preview__heading">{copy.filesHeading(detail.files.length)}</h3>
        <ul className="nova-skill-preview__files">
          {detail.files.map((file) => (
            <li key={file.path}>
              <code>{file.path}</code> · {SKILL_FILE_KIND_LABELS[file.kind]} · {formatInteger(file.size)} o
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={copy.contentHeading}>
        <h3 className="nova-skill-preview__heading">{copy.contentHeading}</h3>
        <pre className="nova-skill-preview__content">{detail.content}</pre>
      </section>
    </div>
  );
}

export function SkillPreviewDialog({
  mode,
  state,
  busy,
  onConfirm,
  onClose,
}: {
  mode: SkillDialogMode;
  state: SkillDialogState;
  busy: boolean;
  /** Install or enable; absent in view mode. */
  onConfirm?: () => void;
  onClose: () => void;
}) {
  const ready = state.status === "ready" ? state.detail : null;
  const replaces = ready && "replaces" in ready ? ready.replaces : null;
  const confirmLabel = mode === "install" ? (replaces ? copy.replace : copy.install) : copy.enable;
  return (
    <Dialog
      open
      onClose={onClose}
      title={titleOf(mode)}
      size="lg"
      closeLabel={copy.close}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {mode === "view" ? copy.close : skillsCopy.manager.cancel}
          </Button>
          {mode !== "view" && ready && onConfirm ? (
            <Button variant="primary" loading={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          ) : null}
        </>
      }
    >
      {state.status === "loading" ? (
        <div aria-busy="true">
          <p className="nova-note">{copy.reading}</p>
          <Skeleton height={120} radius={10} />
        </div>
      ) : null}
      {state.status === "error" ? <Callout tone="danger">{state.message}</Callout> : null}
      {ready ? <Body detail={ready} mode={mode} /> : null}
    </Dialog>
  );
}

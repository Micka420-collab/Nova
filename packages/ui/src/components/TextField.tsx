import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cx } from "../cx";

interface FieldOwnProps {
  label: string;
  /** Visually hides the label while keeping it as the accessible name. */
  hideLabel?: boolean;
  hint?: ReactNode;
  /** When set, the control is marked aria-invalid and described by this message. */
  error?: ReactNode;
}

export type TextFieldProps = FieldOwnProps & Omit<ComponentPropsWithRef<"input">, "children">;
export type TextAreaProps = FieldOwnProps & Omit<ComponentPropsWithRef<"textarea">, "children">;

function useFieldA11y(id: string | undefined, hint: ReactNode, error: ReactNode, describedBy: string | undefined) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedByIds = [describedBy, hintId, errorId].filter(Boolean).join(" ");
  return {
    controlId,
    hintId,
    errorId,
    control: {
      id: controlId,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedByIds || undefined,
    },
  };
}

function FieldFrame({
  label,
  hideLabel,
  hint,
  error,
  className,
  a11y,
  children,
}: FieldOwnProps & { className: string | undefined; a11y: ReturnType<typeof useFieldA11y>; children: ReactNode }) {
  return (
    <div className={cx("nv-field", Boolean(error) && "nv-field--invalid", className)}>
      <label htmlFor={a11y.controlId} className={cx("nv-field__label", hideLabel && "nv-visually-hidden")}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={a11y.hintId} className="nv-field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={a11y.errorId} className="nv-field__error">
          <CircleAlert aria-hidden size={14} strokeWidth={2.2} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export function TextField({ label, hideLabel, hint, error, id, className, ...rest }: TextFieldProps) {
  const a11y = useFieldA11y(id, hint, error, rest["aria-describedby"]);
  return (
    <FieldFrame label={label} hideLabel={hideLabel} hint={hint} error={error} className={className} a11y={a11y}>
      <input {...rest} {...a11y.control} className="nv-field__control" />
    </FieldFrame>
  );
}

export function TextArea({ label, hideLabel, hint, error, id, className, rows = 4, ...rest }: TextAreaProps) {
  const a11y = useFieldA11y(id, hint, error, rest["aria-describedby"]);
  return (
    <FieldFrame label={label} hideLabel={hideLabel} hint={hint} error={error} className={className} a11y={a11y}>
      <textarea {...rest} {...a11y.control} rows={rows} className="nv-field__control nv-field__control--multiline" />
    </FieldFrame>
  );
}

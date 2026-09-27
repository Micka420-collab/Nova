import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "../cx";

export interface SwitchProps
  extends Omit<ComponentPropsWithRef<"button">, "children" | "onChange" | "role" | "type" | "value"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  hideLabel?: boolean;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  hideLabel,
  id,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  const generated = useId();
  const switchId = id ?? generated;
  const descriptionId = description ? `${switchId}-description` : undefined;
  return (
    <div className={cx("nv-switch-row", className)}>
      <span className={cx("nv-switch-row__text", hideLabel && "nv-visually-hidden")}>
        <label htmlFor={switchId} className="nv-switch-row__label">
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="nv-switch-row__description">
            {description}
          </span>
        ) : null}
      </span>
      <button
        {...rest}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descriptionId}
        className="nv-switch"
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onCheckedChange(!checked);
        }}
      >
        <span className="nv-switch__thumb" aria-hidden />
      </button>
    </div>
  );
}

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../cx";
import type { ControlSize } from "./Button";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the radio group. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: ControlSize;
  className?: string;
}

const STEP_BY_KEY: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Radio group with roving focus: arrows move and select (wrapping, skipping disabled), Home/End jump. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop = selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : enabled[0];

  function select(index: number | undefined) {
    const option = index === undefined ? undefined : options[index];
    if (index === undefined || !option) return;
    buttons.current[index]?.focus();
    if (option.value !== value) onChange(option.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = STEP_BY_KEY[event.key];
    const position = enabled.indexOf(index);
    let target: number | undefined;
    if (step !== undefined) target = enabled[(position + step + enabled.length) % enabled.length];
    else if (event.key === "Home") target = enabled[0];
    else if (event.key === "End") target = enabled.at(-1);
    else return;
    event.preventDefault();
    select(target);
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx("nv-segmented", `nv-segmented--${size}`, className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- APG radio group with roving focus (onKeyDown)
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            tabIndex={index === tabStop ? 0 : -1}
            className="nv-segmented__option"
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

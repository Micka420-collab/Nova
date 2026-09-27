import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../cx";
import { OrbitIndicator } from "./OrbitIndicator";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Shows the active orbit, sets aria-busy and disables the button until the operation ends. */
  loading?: boolean;
  /** Leading icon, replaced by the orbit while loading. */
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("nv-button", `nv-button--${variant}`, `nv-button--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <OrbitIndicator active size={size === "sm" ? 14 : 16} /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children" | "aria-label"> {
  /** Required: an icon-only button has no other accessible name. */
  "aria-label": string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ControlSize;
}

export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("nv-button", "nv-icon-button", `nv-button--${variant}`, `nv-button--${size}`, className)}
    >
      {icon}
    </button>
  );
}

import type { ComponentPropsWithRef, CSSProperties } from "react";
import { cx } from "../cx";

export function Kbd({ className, ...rest }: ComponentPropsWithRef<"kbd">) {
  return <kbd {...rest} className={cx("nv-kbd", className)} />;
}

export function VisuallyHidden({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span {...rest} className={cx("nv-visually-hidden", className)} />;
}

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: CSSProperties["borderRadius"];
  className?: string;
}

/** Placeholder block for content that is really loading; hidden from assistive technology. */
export function Skeleton({ width = "100%", height = 14, radius, className }: SkeletonProps) {
  return <span aria-hidden className={cx("nv-skeleton", className)} style={{ width, height, borderRadius: radius }} />;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Accessible naming for decorative-or-meaningful SVGs: named image when labelled, hidden otherwise. */
export function svgA11y(label: string | undefined) {
  return label ? ({ role: "img", "aria-label": label } as const) : ({ "aria-hidden": true } as const);
}

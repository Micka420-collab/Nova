// Keyboard zones (POWER_UX §2.2 "Zones et focus", §6.4): F6 / Maj+F6 cycle navigation → explorer →
// center → workbench → dock → agent panel. Only zones present in the DOM take part; focus goes to
// the zone's first focusable control, or to the zone itself.

/** Order of the zones, as landmarks of the shell (Workshop.tsx, Rail.tsx, Dock.tsx). */
export const ZONE_SELECTORS: readonly string[] = [
  ".nova-rail",
  ".nova-zone--nav",
  "#nova-main",
  ".nova-zone--context",
  ".nova-dock-panel",
  ".nova-zone--agent",
];

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function presentZones(root: ParentNode): HTMLElement[] {
  const zones: HTMLElement[] = [];
  for (const selector of ZONE_SELECTORS) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      // A zone nested in another (the dock inside the workbench column) is its own stop.
      if (!element.closest("[hidden]") && !zones.includes(element)) zones.push(element);
    }
  }
  return zones;
}

/** Index of the innermost zone containing `element`, or -1. */
function zoneIndexOf(zones: readonly HTMLElement[], element: Element | null): number {
  let found = -1;
  let depth = -1;
  zones.forEach((zone, index) => {
    if (!element || !zone.contains(element)) return;
    let level = 0;
    for (let node: Element | null = zone; node; node = node.parentElement) level += 1;
    if (level > depth) {
      depth = level;
      found = index;
    }
  });
  return found;
}

function focusInside(zone: HTMLElement): void {
  const target = zone.querySelector<HTMLElement>(FOCUSABLE);
  if (target) {
    target.focus();
    return;
  }
  if (!zone.hasAttribute("tabindex")) zone.setAttribute("tabindex", "-1");
  zone.focus();
}

/** Moves focus to the next (1) or previous (-1) zone; returns the zone focused, if any. */
export function focusZone(direction: 1 | -1, root: ParentNode = document): HTMLElement | null {
  const zones = presentZones(root);
  if (zones.length === 0) return null;
  const current = zoneIndexOf(zones, document.activeElement);
  const start = current === -1 ? (direction === 1 ? -1 : 0) : current;
  const next = zones[(start + direction + zones.length) % zones.length];
  if (!next) return null;
  focusInside(next);
  return next;
}

/** Focuses the agent composer once the panel is rendered (after a route change). */
export function focusAgentComposer(): void {
  setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>("[data-agent-panel] textarea")?.focus();
  }, 0);
}

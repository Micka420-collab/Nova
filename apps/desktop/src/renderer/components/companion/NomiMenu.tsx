// P9 quick-actions menu: an ARIA menu anchored to the dock. Entries come from `buildNomiMenu`
// (real facts only); the first line repeats Nomi's state, the same text as its accessible name.
import { NOMI_COPY, type NomiMenuEntry } from "@nova/companion";
import { useEffect, useRef, type KeyboardEvent } from "react";

export interface NomiMenuProps {
  id: string;
  /** « Nomi travaille · Facturation, étape 3/5 ». */
  status: string;
  entries: readonly NomiMenuEntry[];
  busy: boolean;
  onSelect(entry: NomiMenuEntry): void;
  /** Closes the menu; focus goes back to the trigger. */
  onClose(): void;
}

export function NomiMenu({ id, status, entries, busy, onSelect, onClose }: NomiMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
      case "Escape":
      case "Tab":
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      ref={ref}
      id={id}
      className="nova-nomi-menu"
      role="menu"
      aria-label={NOMI_COPY.menu.label}
      aria-busy={busy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <p className="nova-nomi-menu__status">{status}</p>
      {entries.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={entry.id === "nomi.quiet" && index > 0 ? "nova-nomi-menu__item nova-nomi-menu__item--separated" : "nova-nomi-menu__item"}
          disabled={busy}
          onClick={() => onSelect(entry)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../cx";

export interface TabItem {
  key: string;
  label: ReactNode;
  title?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  closable?: boolean;
  closeLabel?: string;
}

export interface TabsProps {
  label: string;
  idPrefix: string;
  items: readonly TabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  onClose?: (key: string) => void;
  className?: string;
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function tabId(idPrefix: string, key: string): string {
  return `${safe(idPrefix)}-tab-${safe(key)}`;
}

export function tabPanelProps(
  idPrefix: string,
  key: string,
): { id: string; role: "tabpanel"; "aria-labelledby": string; tabIndex: 0 } {
  return { id: `${safe(idPrefix)}-panel-${safe(key)}`, role: "tabpanel", "aria-labelledby": tabId(idPrefix, key), tabIndex: 0 };
}

/** Tab strip with roving focus: arrows/Home/End move and select, Delete closes a closable tab. */
export function Tabs({ label, idPrefix, items, activeKey, onSelect, onClose, className }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);

  const focusKey = (key: string) => {
    list.current?.ownerDocument.getElementById(tabId(idPrefix, key))?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = items.length;
    let target: number | null = null;
    if (event.key === "ArrowRight") target = (index + 1) % count;
    else if (event.key === "ArrowLeft") target = (index - 1 + count) % count;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = count - 1;
    else if (event.key === "Delete") {
      const item = items[index];
      if (item?.closable && onClose) {
        event.preventDefault();
        onClose(item.key);
      }
      return;
    }
    if (target === null) return;
    const next = items[target];
    if (!next) return;
    event.preventDefault();
    onSelect(next.key);
    focusKey(next.key);
  };

  return (
    <div ref={list} role="tablist" aria-label={label} className={cx("nv-tabs", className)}>
      {items.map((item, index) => {
        const active = item.key === activeKey;
        const id = tabId(idPrefix, item.key);
        return (
          <span key={item.key} className={cx("nv-tabs__pair", active && "nv-tabs__pair--active")}>
            <button
              type="button"
              role="tab"
              id={id}
              className="nv-tabs__tab"
              aria-selected={active}
              aria-controls={tabPanelProps(idPrefix, item.key).id}
              tabIndex={active ? 0 : -1}
              title={item.title}
              onClick={() => onSelect(item.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item.icon ? <span className="nv-tabs__icon" aria-hidden>{item.icon}</span> : null}
              <span className="nv-tabs__label">{item.label}</span>
              {item.badge !== undefined && item.badge !== null ? <span className="nv-tabs__badge">{item.badge}</span> : null}
            </button>
            {item.closable && onClose ? (
              <button
                type="button"
                className="nv-tabs__close"
                aria-label={item.closeLabel}
                tabIndex={-1}
                onClick={() => onClose(item.key)}
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

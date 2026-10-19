import React, { useEffect, useRef } from "react";
import { IconCheck } from "./Icons";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider line above this item, to group related actions. */
  separatorBefore?: boolean;
  /** Shows a check mark - used by the toolbar's Sort / Group by menus. */
  checked?: boolean;
}

/** A small floating menu positioned at the click point, styled to match the
 *  rest of the app rather than relying on the OS's native context menu -
 *  closes itself on an outside click, a scroll, or Escape. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // A right-click elsewhere closes this menu via the mousedown below, and
    // then opens its own new one - no extra handling needed for that case.
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Keep the menu on-screen even if it's opened near the window's edge.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 32 - 16),
  };

  return (
    <div className="context-menu" style={style} ref={ref}>
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          {item.separatorBefore && i > 0 && <div className="context-menu-sep" />}
          <button
            type="button"
            className={`context-menu-item${item.danger ? " context-menu-item-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.checked !== undefined && (
              <span className="context-menu-check" aria-hidden>
                {item.checked ? <IconCheck size={14} /> : null}
              </span>
            )}
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

import { vaultTempRootOf, vaultTopName } from "../vaultTemp";
import { useEffect, useRef } from "react";
import {
  IconFolder,
  IconHome,
  IconLock,
  IconPlus,
  IconSettings,
  IconTimeline,
  IconTrash,
  IconX,
} from "./Icons";

/** What a tab is showing - enough to put the window back where it was. */
export type TabKind =
  | "browse"
  | "home"
  | "settings"
  | "timeline"
  | "recycle"
  | "vault"
  | "storage";

export interface TabInfo {
  id: number;
  kind: TabKind;
  /** Folder for "browse" and "storage" tabs. */
  dir: string;
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop() || "";
  // "C:" -> "C:\" reads better as a tab title for a drive root.
  return last || p || "Home";
}

export function tabTitle(tab: TabInfo): string {
  switch (tab.kind) {
    case "home":
      return "Home";
    case "settings":
      return "Settings";
    case "timeline":
      return "Timeline";
    case "recycle":
      return "Recycle Bin";
    case "vault":
      return "Your Eyes Only";
    case "storage":
      return tab.dir ? `Storage - ${basename(tab.dir)}` : "Storage";
    default:
      if (tab.dir && vaultTempRootOf(tab.dir)) return vaultTopName(tab.dir);
      return tab.dir ? basename(tab.dir) : "Home";
  }
}

function TabIcon({ kind }: { kind: TabKind }) {
  switch (kind) {
    case "home":
      return <IconHome size={15} />;
    case "settings":
      return <IconSettings size={15} />;
    case "timeline":
      return <IconTimeline size={15} />;
    case "recycle":
      return <IconTrash size={15} />;
    case "vault":
      return <IconLock size={15} />;
    default:
      return <IconFolder size={15} />;
  }
}

interface TitleBarProps {
  tabs: TabInfo[];
  activeId: number;
  theme: "light" | "dark";
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}

/**
 * Windows-Explorer-style header: just the tab strip. The native minimise /
 * maximise / close buttons are drawn by Electron over the right-hand end
 * (titleBarOverlay), and the empty strip drags the window.
 */
export function TitleBar({ tabs, activeId, theme, onSelect, onClose, onNew }: TitleBarProps) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Keep the native window buttons' backdrop in step with the app theme.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-elevated")
        .trim();
      void window.smartsearch
        ?.setTitleBarTheme?.(bg || (theme === "dark" ? "#252526" : "#f3f3f3"), theme === "dark" ? "#ffffff" : "#1b1b1b")
        ?.catch?.(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div className="titlebar" role="tablist" aria-label="Open tabs">
      <div className="titlebar-tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const title = tabTitle(tab);
          return (
            <div
              key={tab.id}
              ref={active ? activeRef : undefined}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`titlebar-tab${active ? " titlebar-tab-active" : ""}`}
              title={
                tab.dir && (tab.kind === "browse" || tab.kind === "storage") && !vaultTempRootOf(tab.dir)
                  ? tab.dir
                  : title
              }
              onMouseDown={(e) => {
                // Middle click closes, like every browser/Explorer tab.
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(tab.id);
                }
              }}
            >
              <span className="titlebar-tab-icon">
                <TabIcon kind={tab.kind} />
              </span>
              <span className="titlebar-tab-title">{title}</span>
              <button
                className="titlebar-tab-close"
                aria-label={`Close tab ${title}`}
                title="Close tab (Ctrl+W)"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <IconX size={10} />
              </button>
            </div>
          );
        })}
        <button className="titlebar-new" onClick={onNew} title="New tab (Ctrl+T)" aria-label="New tab">
          <IconPlus size={14} />
        </button>
      </div>
    </div>
  );
}

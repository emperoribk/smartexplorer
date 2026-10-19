import React from "react";
import {
  IconHome,
  IconDesktop,
  IconDocuments,
  IconDownloads,
  IconPictures,
  IconVideos,
  IconFolder,
  IconClock,
  IconLock,
  IconTimeline,
  IconTrash,
  IconSettings,
} from "./Icons";
import type { DiskUsage, SpecialFolders } from "../types";
import {
  hasInternalDragPayload,
  readDropPayload,
  MOVE_PATHS_MIME,
  type VaultEntryDragPayload,
} from "../dragDrop";

interface PinnedEntry {
  key: string;
  label: string;
  path: string;
  icon: React.ReactNode;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function SidebarRow({
  active,
  icon,
  label,
  path,
  title,
  onNavigate,
  onMoveInto,
  onRestoreVaultEntry,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  path: string;
  title: string;
  onNavigate: (path: string) => void;
  onMoveInto: (paths: string[], destDir: string) => void;
  onRestoreVaultEntry: (entry: VaultEntryDragPayload, destDir: string) => void;
}) {
  const [dropHover, setDropHover] = React.useState(false);
  return (
    <button
      className={`sidebar-item${active ? " sidebar-item-active" : ""}${
        dropHover ? " sidebar-item-drop-hover" : ""
      }`}
      onClick={() => onNavigate(path)}
      title={title}
      onDragOver={(e) => {
        if (!hasInternalDragPayload(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHover(false);
        const payload = readDropPayload(e);
        if (payload?.kind === "move") onMoveInto(payload.paths, path);
        else if (payload?.kind === "vault") onRestoreVaultEntry(payload.entry, path);
      }}
    >
      <span className="sidebar-item-icon">{icon}</span>
      <span className="sidebar-item-label">{label}</span>
    </button>
  );
}

function SidebarActionRow({
  active,
  icon,
  label,
  title,
  onClick,
  onLockToVault,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  onLockToVault?: (paths: string[]) => void;
}) {
  const [dropHover, setDropHover] = React.useState(false);
  return (
    <button
      className={`sidebar-item${active ? " sidebar-item-active" : ""}${
        dropHover ? " sidebar-item-drop-hover" : ""
      }`}
      onClick={onClick}
      title={title}
      onDragOver={
        onLockToVault
          ? (e) => {
              if (!e.dataTransfer.types.includes(MOVE_PATHS_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropHover(true);
            }
          : undefined
      }
      onDragLeave={onLockToVault ? () => setDropHover(false) : undefined}
      onDrop={
        onLockToVault
          ? (e) => {
              e.preventDefault();
              setDropHover(false);
              const raw = e.dataTransfer.getData(MOVE_PATHS_MIME);
              if (!raw) return;
              try {
                const paths: string[] = JSON.parse(raw);
                if (Array.isArray(paths) && paths.length > 0) onLockToVault(paths);
              } catch {
                // Malformed payload - nothing sane to do with it.
              }
            }
          : undefined
      }
    >
      <span className="sidebar-item-icon">{icon}</span>
      <span className="sidebar-item-label">{label}</span>
    </button>
  );
}

/** Formats a byte count as whole gigabytes, the same granularity File
 *  Explorer's own disk-space captions use ("292 GB free of 930 GB") -
 *  more precision than that wouldn't mean anything useful to a person
 *  glancing at a sidebar. */
function formatGB(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

export function Sidebar({
  specialFolders,
  currentDir,
  onNavigate,
  onPickFolder,
  indexedFolders,
  recentFolders,
  onHome,
  homeActive,
  diskUsage,
  onMoveInto,
  onRestoreVaultEntry,
  onOpenVault,
  vaultActive,
  onLockToVault,
  onOpenTimeline,
  timelineActive,
  onOpenRecycleBin,
  recycleActive,
  onOpenStorage,
  storageActive,
  onOpenSettings,
  settingsActive,
  indexProgress,
}: {
  /** First-run background indexing of the main folders - null once it has
   *  finished (or is switched off), so day-to-day catch-up stays invisible. */
  indexProgress?: { waiting: boolean; folder: string; done: number; total: number } | null;
  specialFolders: SpecialFolders | null;
  currentDir: string;
  onNavigate: (path: string) => void;
  onPickFolder: () => void;
  indexedFolders: string[];
  recentFolders: string[];
  /** The "Home" item is a dashboard (Quick access + Recent files), not a
   *  folder to browse to - it gets its own handler instead of onNavigate,
   *  and its own "active" flag instead of the path-comparison every other
   *  pinned/indexed/recent item uses. */
  onHome: () => void;
  homeActive: boolean;
  diskUsage: DiskUsage | null;
  /** A file dragged from the grid (see FileGrid.tsx's Tile) dropped onto a
   *  Pinned/Indexed/Recent row - moves it into that folder, same as
   *  dropping it on one of FileGrid's own directory tiles. */
  onMoveInto: (paths: string[], destDir: string) => void;
  /** A "Your Eyes Only" vault row (see VaultView.tsx's VaultRow) dropped
   *  onto one of these rows instead - restores that locked file straight
   *  into this folder. Always re-asks for a fresh credential first (see
   *  App.tsx's handleRestoreVaultEntry); this callback only fires once
   *  that's already been arranged. */
  onRestoreVaultEntry: (entry: VaultEntryDragPayload, destDir: string) => void;
  /** "Your Eyes Only" used to live as a button in the
   *  top toolbar - moved here as its own sidebar nav row, right under
   *  Home. onOpenVault already carries its own toggle logic
   *  (open it, or go back to plain browsing if already open) - this
   *  component just renders them as rows and reports clicks/drops. */
  onOpenVault: () => void;
  vaultActive: boolean;
  /** A file dragged onto the "Your Eyes Only" row - locks it in, same as
   *  the right-click "Move to Your Eyes Only" action (see SidebarActionRow
   *  above for why this is the one row that accepts a drop at all). */
  onLockToVault: (paths: string[]) => void;
  onOpenTimeline: () => void;
  timelineActive: boolean;
  /** Opens the Recycle Bin screen (list / restore / delete permanently). */
  onOpenRecycleBin: () => void;
  recycleActive: boolean;
  /** The "This PC" disk-space bar below, clicked - opens the storage
   *  chart scanning that same drive (see StorageView.tsx). */
  onOpenStorage: (root: string) => void;
  storageActive: boolean;
  /** Opens Settings (theme, accent color, browsing options). */
  onOpenSettings: () => void;
  settingsActive: boolean;
}) {
  const pinned: PinnedEntry[] = specialFolders
    ? [
        { key: "desktop", label: "Desktop", path: specialFolders.desktop, icon: <IconDesktop /> },
        {
          key: "downloads",
          label: "Downloads",
          path: specialFolders.downloads,
          icon: <IconDownloads />,
        },
        {
          key: "documents",
          label: "Documents",
          path: specialFolders.documents,
          icon: <IconDocuments />,
        },
        {
          key: "pictures",
          label: "Pictures",
          path: specialFolders.pictures,
          icon: <IconPictures />,
        },
        { key: "videos", label: "Videos", path: specialFolders.videos, icon: <IconVideos /> },
      ]
    : [];

  const isCurrent = (p: string) =>
    p.replace(/[\\/]+$/, "").toLowerCase() === currentDir.replace(/[\\/]+$/, "").toLowerCase();

  // Only one place in the app is "current" at a time: while a special view
  // (Home, Eyes Only, Timeline, Recycle Bin, Storage) is open, no folder row
  // should also look selected.
  const folderRowsActive =
    !homeActive && !vaultActive && !timelineActive && !recycleActive && !storageActive && !settingsActive;

  return (
    <div className="sidebar">
      <nav className="sidebar-section">
        <button
          className={`sidebar-item${homeActive ? " sidebar-item-active" : ""}`}
          onClick={onHome}
          title="Home"
        >
          <span className="sidebar-item-icon">
            <IconHome />
          </span>
          <span className="sidebar-item-label">Home</span>
        </button>
        <SidebarActionRow
          active={vaultActive}
          icon={<IconLock />}
          label="Your Eyes Only"
          title="Your Eyes Only - files with sensitive content are hidden and encrypted here automatically. Drag a file here, or right-click it, to move it in yourself."
          onClick={onOpenVault}
          onLockToVault={onLockToVault}
        />
        <SidebarActionRow
          active={timelineActive}
          icon={<IconTimeline />}
          label="Timeline"
          title="Every indexed file, all types mixed, newest first - like a photos app"
          onClick={onOpenTimeline}
        />
        <SidebarActionRow
          active={recycleActive}
          icon={<IconTrash />}
          label="Recycle Bin"
          title="See what you've deleted - restore it, or delete some or all of it permanently"
          onClick={onOpenRecycleBin}
        />
      </nav>

      <nav className="sidebar-section">
        <div className="sidebar-heading sidebar-heading-row">
          <span>Pinned</span>
          <button
            className="sidebar-open-btn"
            onClick={onPickFolder}
            title="Open folder…"
            aria-label="Open folder…"
          >
            <IconFolder size={14} />
          </button>
        </div>
        {pinned.map((item) => (
          <SidebarRow
            key={item.key}
            active={folderRowsActive && isCurrent(item.path)}
            icon={item.icon}
            label={item.label}
            path={item.path}
            title={item.path}
            onNavigate={onNavigate}
            onMoveInto={onMoveInto}
            onRestoreVaultEntry={onRestoreVaultEntry}
          />
        ))}
      </nav>

      {indexedFolders.length > 0 && (
        <nav className="sidebar-section">
          <div className="sidebar-heading">Indexed</div>
          {indexedFolders.map((p) => (
            <SidebarRow
              key={p}
              active={folderRowsActive && isCurrent(p)}
              icon={<IconFolder size={16} />}
              label={basename(p)}
              path={p}
              title={p}
              onNavigate={onNavigate}
              onMoveInto={onMoveInto}
              onRestoreVaultEntry={onRestoreVaultEntry}
            />
          ))}
        </nav>
      )}

      {recentFolders.length > 0 && (
        <nav className="sidebar-section">
          <div className="sidebar-heading">
            <IconClock size={12} className="sidebar-heading-icon" />
            Recent
          </div>
          {recentFolders.map((p) => (
            <SidebarRow
              key={p}
              active={folderRowsActive && isCurrent(p)}
              icon={<IconFolder size={16} />}
              label={basename(p)}
              path={p}
              title={p}
              onNavigate={onNavigate}
              onMoveInto={onMoveInto}
              onRestoreVaultEntry={onRestoreVaultEntry}
            />
          ))}
        </nav>
      )}

      <div className="sidebar-bottom">
      {indexProgress && (
        <div className="sidebar-index-card" role="status" aria-live="polite">
          <div className="sidebar-index-title">Getting your files ready</div>
          <div className="sidebar-index-sub">
            {indexProgress.waiting
              ? "Preparing smart search…"
              : `${indexProgress.folder ? indexProgress.folder + " · " : ""}${indexProgress.done.toLocaleString()} of ${indexProgress.total.toLocaleString()}`}
          </div>
          <div className="sidebar-disk-bar">
            <div
              className={`sidebar-disk-bar-fill${indexProgress.waiting ? " sidebar-index-pulse" : ""}`}
              style={{
                width: indexProgress.waiting
                  ? "40%"
                  : `${indexProgress.total > 0 ? Math.min(100, (indexProgress.done / indexProgress.total) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="sidebar-index-note">You can keep using the app.</div>
        </div>
      )}
      <nav className="sidebar-section">
        <SidebarActionRow
          active={settingsActive}
          icon={<IconSettings />}
          label="Settings"
          title="Theme, accent color and browsing options"
          onClick={onOpenSettings}
        />
      </nav>

      {diskUsage && (
        <nav className="sidebar-section sidebar-section-disk">
          <div className="sidebar-heading">This PC</div>
          <button
            className={`sidebar-disk${storageActive ? " sidebar-disk-active" : ""}`}
            title={`${formatGB(diskUsage.free)} free of ${formatGB(diskUsage.total)} - click to see what's using the space`}
            onClick={() => onOpenStorage(diskUsage.root)}
          >
            <div className="sidebar-disk-label">{diskUsage.label}</div>
            <div className="sidebar-disk-bar">
              <div
                className="sidebar-disk-bar-fill"
                style={{
                  width: `${diskUsage.total > 0 ? Math.min(100, ((diskUsage.total - diskUsage.free) / diskUsage.total) * 100) : 0}%`,
                }}
              />
            </div>
            <div className="sidebar-disk-caption">
              {formatGB(diskUsage.free)} free of {formatGB(diskUsage.total)}
            </div>
          </button>
        </nav>
      )}
      </div>
    </div>
  );
}

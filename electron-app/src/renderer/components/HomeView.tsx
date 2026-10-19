import React from "react";
import {
  IconDesktop,
  IconDocuments,
  IconDownloads,
  IconFolder,
  IconPictures,
  IconVideos,
  IconClock,
} from "./Icons";
import { FileGrid } from "./FileGrid";
import type { GridItem } from "../gridItem";
import type { SpecialFolders, SuggestNameResponse } from "../types";

interface QuickAccessTile {
  key: string;
  label: string;
  path: string;
  location: string;
  icon: React.ReactNode;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function parentLabel(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 2] ?? p;
}

// Only up to this many extra (non-special) tiles get pulled in from indexed
// + recent folders - Quick access is meant to be a handful of places worth
// a single glance, not a second copy of the whole sidebar.
const MAX_EXTRA_TILES = 8;

/** The Home dashboard: a "Quick access" tile row (the special folders, plus
 *  whatever else has been indexed or recently visited) above a "Recent
 *  files" grid of files actually opened through the app - the same two
 *  ideas File Explorer's own Home page is built from, just backed by
 *  SmartSearch's own indexing instead of the Windows shell's recent-items
 *  list. */
export function HomeView({
  specialFolders,
  indexedFolders,
  recentFolders,
  recentItems,
  recentLoading,
  onNavigate,
  selectedPaths,
  renamingPath,
  onSelect,
  onOpenFile,
  onItemContextMenu,
  onBackgroundContextMenu,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onSuggestName,
  onMoveInto,
  topSlot,
}: {
  specialFolders: SpecialFolders | null;
  indexedFolders: string[];
  recentFolders: string[];
  recentItems: GridItem[];
  recentLoading: boolean;
  onNavigate: (path: string) => void;
  /** See FileGrid's own doc comment - passed straight through, since this
   *  view's "Recent files" grid is just another FileGrid instance. */
  selectedPaths: ReadonlySet<string>;
  renamingPath: string | null;
  onSelect: (item: GridItem | null, e: React.MouseEvent | null) => void;
  onOpenFile: (path: string) => void;
  onItemContextMenu: (item: GridItem, x: number, y: number) => void;
  onBackgroundContextMenu: (x: number, y: number) => void;
  onStartRename: (item: GridItem) => void;
  onRenameCommit: (item: GridItem, newName: string) => void;
  onRenameCancel: () => void;
  onSuggestName: (item: GridItem) => Promise<SuggestNameResponse>;
  /** Also passed straight through to the "Recent files" FileGrid - lets a
   *  recent item be dragged onto one of its own sibling folder tiles, same
   *  as in the normal browse view. */
  onMoveInto: (paths: string[], destDir: string) => void;
  /** Rendered above everything else - the Memories strip. */
  topSlot?: React.ReactNode;
}) {
  const specials: QuickAccessTile[] = specialFolders
    ? [
        {
          key: "desktop",
          label: "Desktop",
          path: specialFolders.desktop,
          location: "Stored locally",
          icon: <IconDesktop size={22} />,
        },
        {
          key: "downloads",
          label: "Downloads",
          path: specialFolders.downloads,
          location: "Stored locally",
          icon: <IconDownloads size={22} />,
        },
        {
          key: "documents",
          label: "Documents",
          path: specialFolders.documents,
          location: "Stored locally",
          icon: <IconDocuments size={22} />,
        },
        {
          key: "pictures",
          label: "Pictures",
          path: specialFolders.pictures,
          location: "Stored locally",
          icon: <IconPictures size={22} />,
        },
        {
          key: "videos",
          label: "Videos",
          path: specialFolders.videos,
          location: "Stored locally",
          icon: <IconVideos size={22} />,
        },
      ]
    : [];

  const specialPaths = new Set(specials.map((s) => s.path.toLowerCase()));
  const seen = new Set(specialPaths);
  const extras: QuickAccessTile[] = [];
  for (const p of [...indexedFolders, ...recentFolders]) {
    const key = p.toLowerCase();
    if (seen.has(key) || extras.length >= MAX_EXTRA_TILES) continue;
    seen.add(key);
    extras.push({
      key: p,
      label: basename(p),
      path: p,
      location: parentLabel(p),
      icon: <IconFolder size={22} />,
    });
  }

  const tiles = [...specials, ...extras];

  return (
    <div className="home-view">
      {topSlot}
      {tiles.length > 0 && (
        <div className="home-section">
          <div className="home-section-heading">Quick access</div>
          <div className="home-quick-access">
            {tiles.map((tile) => (
              <button
                key={tile.key}
                type="button"
                className="home-quick-tile"
                onClick={() => onNavigate(tile.path)}
                title={tile.path}
              >
                <span className="home-quick-tile-icon">{tile.icon}</span>
                <span className="home-quick-tile-text">
                  <span className="home-quick-tile-label">{tile.label}</span>
                  <span className="home-quick-tile-location">{tile.location}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="home-section home-section-recent">
        <div className="home-section-heading">
          <IconClock size={13} className="sidebar-heading-icon" />
          Recent files
        </div>
        {recentItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-glyph">
              <IconClock size={40} />
            </div>
            <div>{recentLoading ? "Loading…" : "Files you open in SmartExplorer will show up here."}</div>
          </div>
        ) : (
          <FileGrid
            items={recentItems}
            grouped={false}
            showFolder
            selectedPaths={selectedPaths}
            renamingPath={renamingPath}
            onSelect={onSelect}
            onOpenDirectory={onNavigate}
            onOpenFile={onOpenFile}
            onItemContextMenu={onItemContextMenu}
            onBackgroundContextMenu={onBackgroundContextMenu}
            onStartRename={onStartRename}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
            onSuggestName={onSuggestName}
            onMoveInto={onMoveInto}
          />
        )}
      </div>
    </div>
  );
}

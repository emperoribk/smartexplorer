import React, { useEffect, useMemo, useState } from "react";
import type { DuplicatesResponse, ExactDuplicateGroup, NearDuplicateGroup, NearDuplicateDocumentGroup } from "../types";
import type { GridItem } from "../gridItem";
import { ImageTile } from "./FileGrid";
import { IconFolder, IconFile, IconPdf, IconPackage, IconOther, IconPlay, IconCopyStack } from "./Icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const INSTALLER_EXTS = new Set([".exe", ".msi", ".msix", ".dmg", ".pkg", ".appimage"]);

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i).toLowerCase() : "";
}

/** Maps a duplicates-API file (which only knows the backend's coarse
 *  'text' | 'image' | 'video' | 'other' kind) onto the same thumbnail kinds
 *  FileGrid uses, so PDFs/installers get their own icon instead of a bare
 *  document glyph - same sniffing gridItem.ts's fromSearchResult does. */
function thumbKind(filename: string, backendKind: string): GridItem["kind"] {
  if (backendKind === "image") return "image";
  if (backendKind === "video") return "video";
  const ext = extOf(filename);
  if (ext === ".pdf") return "pdf";
  if (INSTALLER_EXTS.has(ext)) return "installer";
  if (backendKind === "text") return "text";
  return "other";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** One file's row inside a duplicate group: a small thumbnail, its name/
 *  location, and a checkbox for "include this one in what gets deleted".
 *  Deliberately not a full FileGrid Tile - no rename, no drag, no context
 *  menu - this view's only actions are "look at it" and "select it".
 *
 *  Selection works two ways, and they're independent on purpose:
 *   - the checkbox is a plain toggle for this one row only, regardless of
 *     modifier keys, and never touches any other row's state.
 *   - clicking anywhere else on the row runs the same click/Ctrl/Shift
 *     matrix Explorer's file list uses (see DuplicatesView.handleRowClick),
 *     so a person can click-and-Ctrl/Shift-click their way through a big
 *     group the same way they already know how to. */
function DupFileRow({
  path,
  filename,
  kind,
  checked,
  disabledReason,
  onToggle,
  onRowClick,
  onRowContextMenu,
  onShowInFolder,
  onOpen,
}: {
  path: string;
  filename: string;
  kind: string;
  checked: boolean;
  /** Previously forced non-null for the sole remaining unchecked file in a
   *  group, disabling its checkbox so "delete selected" could never wipe a
   *  file out of existence entirely. Removed by explicit user request - the
   *  user wants to be able to select every copy in a group, including all
   *  of them, if that's what they want deleted. Callers now always pass
   *  null; the disabled-checkbox styling/plumbing is left in place in case
   *  a future opt-in guard wants it. */
  disabledReason: string | null;
  onToggle: () => void;
  onRowClick: (e: React.MouseEvent) => void;
  onRowContextMenu: (e: React.MouseEvent) => void;
  onShowInFolder: () => void;
  onOpen: () => void;
}) {
  const renderKind = thumbKind(filename, kind);
  const gridItem: GridItem = { path, name: filename, isDirectory: false, kind: renderKind };

  return (
    <div
      className={`dup-row${checked ? " dup-row-checked" : ""}`}
      onClick={onRowClick}
      onContextMenu={onRowContextMenu}
    >
      <input
        type="checkbox"
        className="dup-row-checkbox"
        checked={checked}
        disabled={!!disabledReason}
        title={disabledReason ?? "Select for deletion"}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="dup-row-thumb" onDoubleClick={onOpen} title="Double-click to open">
        {renderKind === "image" ? (
          <ImageTile item={gridItem} />
        ) : renderKind === "video" ? (
          <IconPlay size={22} className="tile-icon-glyph" />
        ) : renderKind === "pdf" ? (
          <IconPdf size={22} className="tile-icon-glyph pdf-glyph" />
        ) : renderKind === "installer" ? (
          <IconPackage size={22} className="tile-icon-glyph installer-glyph" />
        ) : renderKind === "text" ? (
          <IconFile size={22} className="tile-icon-glyph" />
        ) : (
          <IconOther size={22} className="tile-icon-glyph" />
        )}
      </div>
      <div className="dup-row-info">
        <span className="dup-row-name" title={path}>
          {filename}
        </span>
        <span className="dup-row-path" title={path}>
          {path}
        </span>
      </div>
      <button
        className="dup-row-locate"
        onClick={(e) => {
          e.stopPropagation();
          onShowInFolder();
        }}
        title="Show in folder"
      >
        <IconFolder size={14} />
      </button>
    </div>
  );
}

function ExactGroupCard({
  group,
  selected,
  onToggleFile,
  onRowClick,
  onRowContextMenu,
  onShowInFolder,
  onOpenFile,
}: {
  group: ExactDuplicateGroup;
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onRowClick: (path: string, e: React.MouseEvent) => void;
  onRowContextMenu: (path: string, e: React.MouseEvent) => void;
  onShowInFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="dup-group">
      <div className="dup-group-heading">
        <span className="dup-group-badge dup-group-badge-exact">Identical</span>
        <span>
          {group.paths.length} exact copies • {formatSize(group.size)} each • reclaim up to{" "}
          {formatSize(group.size * (group.paths.length - 1))}
        </span>
      </div>
      <div className="dup-group-files">
        {group.paths.map((path, i) => (
          <DupFileRow
            key={path}
            path={path}
            filename={group.filenames[i]}
            kind={group.kind}
            checked={selected.has(path)}
            disabledReason={null}
            onToggle={() => onToggleFile(path)}
            onRowClick={(e) => onRowClick(path, e)}
            onRowContextMenu={(e) => onRowContextMenu(path, e)}
            onShowInFolder={() => onShowInFolder(path)}
            onOpen={() => onOpenFile(path)}
          />
        ))}
      </div>
    </div>
  );
}

function NearDupGroupCard({
  group,
  selected,
  onToggleFile,
  onRowClick,
  onRowContextMenu,
  onShowInFolder,
  onOpenFile,
}: {
  group: NearDuplicateGroup;
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onRowClick: (path: string, e: React.MouseEvent) => void;
  onRowContextMenu: (path: string, e: React.MouseEvent) => void;
  onShowInFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="dup-group">
      <div className="dup-group-heading">
        <span className="dup-group-badge dup-group-badge-near">Similar photos</span>
        <span>
          {group.paths.length} images, {Math.round(group.min_similarity * 100)}
          {group.min_similarity < group.max_similarity - 0.001
            ? `-${Math.round(group.max_similarity * 100)}`
            : ""}
          % alike
        </span>
      </div>
      <div className="dup-group-files">
        {group.paths.map((path, i) => (
          <DupFileRow
            key={path}
            path={path}
            filename={group.filenames[i]}
            kind="image"
            checked={selected.has(path)}
            disabledReason={null}
            onToggle={() => onToggleFile(path)}
            onRowClick={(e) => onRowClick(path, e)}
            onRowContextMenu={(e) => onRowContextMenu(path, e)}
            onShowInFolder={() => onShowInFolder(path)}
            onOpen={() => onOpenFile(path)}
          />
        ))}
      </div>
    </div>
  );
}

/** Same card shape as NearDupGroupCard above, for near-duplicate
 *  *documents* (see duplicates.py's find_near_duplicate_documents) - the
 *  one real difference is each row's thumbnail kind isn't fixed to one
 *  value the way "image" is there, since a group here can mix PDFs,
 *  DOCX files, and plain text together (the same letter saved in more
 *  than one format is exactly the kind of match this is meant to catch),
 *  so thumbKind looks at each file's own extension. */
function NearDupDocGroupCard({
  group,
  selected,
  onToggleFile,
  onRowClick,
  onRowContextMenu,
  onShowInFolder,
  onOpenFile,
}: {
  group: NearDuplicateDocumentGroup;
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onRowClick: (path: string, e: React.MouseEvent) => void;
  onRowContextMenu: (path: string, e: React.MouseEvent) => void;
  onShowInFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="dup-group">
      <div className="dup-group-heading">
        <span className="dup-group-badge dup-group-badge-near">Similar documents</span>
        <span>
          {group.paths.length} documents, {Math.round(group.min_similarity * 100)}
          {group.min_similarity < group.max_similarity - 0.001
            ? `-${Math.round(group.max_similarity * 100)}`
            : ""}
          % alike
        </span>
      </div>
      <div className="dup-group-files">
        {group.paths.map((path, i) => (
          <DupFileRow
            key={path}
            path={path}
            filename={group.filenames[i]}
            kind="text"
            checked={selected.has(path)}
            disabledReason={null}
            onToggle={() => onToggleFile(path)}
            onRowClick={(e) => onRowClick(path, e)}
            onRowContextMenu={(e) => onRowContextMenu(path, e)}
            onShowInFolder={() => onShowInFolder(path)}
            onOpen={() => onOpenFile(path)}
          />
        ))}
      </div>
    </div>
  );
}

/** The paths in every group, in the same order they render in - the
 *  coordinate system range-select and Ctrl+Arrow walk. Groups are drawn
 *  exact-duplicates-first then near-duplicates, each in its own path order,
 *  so this has to be built the same way or Shift-click ranges would jump
 *  around relative to what's on screen. */
function flattenPaths(data: DuplicatesResponse | null): string[] {
  if (!data) return [];
  const out: string[] = [];
  for (const g of data.exact_groups) out.push(...g.paths);
  for (const g of data.near_duplicate_groups) out.push(...g.paths);
  for (const g of data.near_duplicate_document_groups) out.push(...g.paths);
  return out;
}

function rangeBetween(order: string[], a: string, b: string): string[] {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 || ib === -1) return [b];
  const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
  return order.slice(lo, hi + 1);
}

export function DuplicatesView({
  currentDir,
  loading,
  data,
  onDeleteSelected,
}: {
  currentDir: string;
  /** True while a scan is in flight - the first scan of a folder that
   *  hasn't been indexed yet also has to wait for indexing to finish, since
   *  duplicate detection is entirely a read of the existing index (hashes +
   *  CLIP embeddings), not its own separate scan. */
  loading: boolean;
  data: DuplicatesResponse | null;
  onDeleteSelected: (paths: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Explorer-style click selection needs two extra bits of state beyond
  // "which paths are selected":
  //  - anchorPath: where a Shift-click range starts from. Set on every
  //    plain or Ctrl click, left alone by Shift clicks so repeated
  //    Shift-clicks keep extending from the same starting point.
  //  - focusPath: the most recently interacted-with row. Ctrl+ArrowUp/Down
  //    walks from here rather than from the anchor, so alternating
  //    Ctrl+Arrow presses keep growing the selection in one direction.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [focusPath, setFocusPath] = useState<string | null>(null);

  // Right-click menu: { x, y, path } for the row that was right-clicked, or
  // null when it's closed. Positioned at the click point like the main file
  // grid's own context menu (see App.tsx / ContextMenu.tsx) - same
  // component, same look, just a different set of actions.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(
    null
  );

  const allPaths = useMemo(() => flattenPaths(data), [data]);

  // Nothing pre-selected when a fresh set of results comes in - the person
  // asked explicitly not to see everything highlighted the moment duplicates
  // are found. This only fires when `data` itself changes identity, which
  // only happens when a new scan completes or a delete triggers a refetch
  // (see App.tsx's fetchDuplicates/handleDeleteDuplicates) - never while
  // someone is mid-click inside an unchanged result set.
  useEffect(() => {
    setSelected(new Set());
    setAnchorPath(null);
    setFocusPath(null);
  }, [data]);

  const toggleFile = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // The click/Ctrl/Shift matrix Windows Explorer's own file list uses:
  //  - plain click:        select only this row
  //  - Ctrl+click:         toggle just this row, keep everything else as-is
  //  - Shift+click:        replace the selection with the range from the
  //                        anchor to here
  //  - Ctrl+Shift+click:   add the range from the anchor to here to
  //                        whatever was already selected, instead of
  //                        replacing it
  const handleRowClick = (path: string, e: React.MouseEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    if (shift) {
      const anchor = anchorPath ?? path;
      const range = rangeBetween(allPaths, anchor, path);
      setSelected((prev) => (ctrl ? new Set([...prev, ...range]) : new Set(range)));
      if (anchorPath === null) setAnchorPath(path);
      setFocusPath(path);
      return;
    }

    if (ctrl) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setAnchorPath(path);
      setFocusPath(path);
      return;
    }

    setSelected(new Set([path]));
    setAnchorPath(path);
    setFocusPath(path);
  };

  // Right-click: matches Explorer's own rule for when it changes the
  // selection versus leaves it alone. Right-clicking a row that's already
  // part of a multi-file selection keeps that whole selection so "Delete"
  // in the menu acts on everything you'd highlighted; right-clicking
  // outside the current selection (or with nothing selected) selects just
  // that one row first, same as a plain left click would.
  const handleRowContextMenu = (path: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (!selected.has(path)) {
      setSelected(new Set([path]));
      setAnchorPath(path);
      setFocusPath(path);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, path });
  };

  // Ctrl+ArrowUp/Down: grow the selection by one row in that direction from
  // wherever focus currently is, the keyboard equivalent of the mouse
  // gestures above. Bound to Ctrl specifically (rather than the plain or
  // Shift-modified arrows Explorer itself uses) per how this was asked for.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (allPaths.length === 0) return;
      e.preventDefault();

      const base = focusPath ?? anchorPath ?? allPaths[0];
      let idx = allPaths.indexOf(base);
      if (idx === -1) idx = 0;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const nextIdx = Math.min(Math.max(idx + delta, 0), allPaths.length - 1);
      const nextPath = allPaths[nextIdx];

      setSelected((prev) => new Set([...prev, base, nextPath]));
      setAnchorPath((prev) => prev ?? base);
      setFocusPath(nextPath);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [allPaths, anchorPath, focusPath]);

  const reclaimableBytes = useMemo(() => {
    if (!data) return 0;
    let total = 0;
    for (const g of data.exact_groups) {
      for (const p of g.paths) {
        if (selected.has(p)) total += g.size;
      }
    }
    return total;
  }, [data, selected]);

  // Same menu component and visual style as the main file grid's right-click
  // menu (App.tsx's contextMenuItems / ContextMenu.tsx) - "Open" and "Show
  // in File Explorer" only make sense for a single target, so they're left
  // off once more than one file is selected; "Delete" always acts on the
  // whole current selection (which handleRowContextMenu has already set up
  // to include whatever was right-clicked) and is worded with the count so
  // it's clear a multi-file delete is about to happen.
  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? [
        ...(selected.size <= 1
          ? [
              { label: "Open", onClick: () => window.smartsearch.openPath(contextMenu.path) },
              {
                label: window.smartsearch.platform === "darwin" ? "Show in Finder" : "Show in File Explorer",
                onClick: () => window.smartsearch.showInFolder(contextMenu.path),
              },
            ]
          : []),
        {
          label: `Delete ${selected.size} file${selected.size === 1 ? "" : "s"}`,
          onClick: () => onDeleteSelected(Array.from(selected)),
          danger: true,
          separatorBefore: true,
        },
      ]
    : [];

  const totalGroups =
    (data?.exact_groups.length ?? 0) +
    (data?.near_duplicate_groups.length ?? 0) +
    (data?.near_duplicate_document_groups.length ?? 0);
  const totalFlaggedFiles =
    (data?.exact_groups.reduce((n, g) => n + g.paths.length, 0) ?? 0) +
    (data?.near_duplicate_groups.reduce((n, g) => n + g.paths.length, 0) ?? 0) +
    (data?.near_duplicate_document_groups.reduce((n, g) => n + g.paths.length, 0) ?? 0);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconCopyStack size={40} />
        </div>
        <div>Scanning {basename(currentDir)} for duplicates…</div>
      </div>
    );
  }

  if (!data || totalGroups === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconCopyStack size={40} />
        </div>
        <div>No duplicate or near-duplicate files found here.</div>
      </div>
    );
  }

  return (
    <div className="dup-view">
      <div className="dup-summary">
        <span>
          {totalGroups} group{totalGroups === 1 ? "" : "s"} • {totalFlaggedFiles} files involved
          {reclaimableBytes > 0 && <> • {formatSize(reclaimableBytes)} selected to reclaim</>}
        </span>
        <div className="dup-summary-actions">
          <button className="dup-clear-selection" onClick={() => setSelected(new Set())}>
            Select none
          </button>
          <button
            className="dup-delete-btn"
            disabled={selected.size === 0}
            onClick={() => onDeleteSelected(Array.from(selected))}
          >
            Move {selected.size} selected to Recycle Bin
          </button>
        </div>
      </div>
      <div className="dup-groups-scroll">
        {data.exact_groups.map((g) => (
          <ExactGroupCard
            key={g.paths.join("|")}
            group={g}
            selected={selected}
            onToggleFile={toggleFile}
            onRowClick={handleRowClick}
            onRowContextMenu={handleRowContextMenu}
            onShowInFolder={(p) => window.smartsearch.showInFolder(p)}
            onOpenFile={(p) => window.smartsearch.openPath(p)}
          />
        ))}
        {data.near_duplicate_groups.map((g, i) => (
          <NearDupGroupCard
            key={g.paths.join("|") + i}
            group={g}
            selected={selected}
            onToggleFile={toggleFile}
            onRowClick={handleRowClick}
            onRowContextMenu={handleRowContextMenu}
            onShowInFolder={(p) => window.smartsearch.showInFolder(p)}
            onOpenFile={(p) => window.smartsearch.openPath(p)}
          />
        ))}
        {data.near_duplicate_document_groups.map((g, i) => (
          <NearDupDocGroupCard
            key={g.paths.join("|") + i}
            group={g}
            selected={selected}
            onToggleFile={toggleFile}
            onRowClick={handleRowClick}
            onRowContextMenu={handleRowContextMenu}
            onShowInFolder={(p) => window.smartsearch.showInFolder(p)}
            onOpenFile={(p) => window.smartsearch.openPath(p)}
          />
        ))}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

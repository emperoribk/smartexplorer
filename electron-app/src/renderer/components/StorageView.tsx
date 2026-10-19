import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { BackendClient } from "../api";
import type { DiskUsageEntry, DiskUsageScanStatus } from "../types";
import { IconFolder, IconFile, IconWarning, IconRefresh } from "./Icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** Splits a path into clickable breadcrumb segments - a small local copy
 *  of Breadcrumb.tsx's segments() (that component is wired for the file
 *  grid's drag-to-move targets, which don't apply here), handling both
 *  POSIX and Windows separators. */
function pathSegments(fullPath: string, platform: string): { label: string; path: string }[] {
  const isWindows = platform === "win32";
  const sep = isWindows ? "\\" : "/";
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    if (isWindows && i === 0) {
      acc = parts[0] + sep; // "C:" -> "C:\"
    } else {
      acc = acc.endsWith(sep) ? acc + parts[i] : acc + sep + parts[i];
    }
    crumbs.push({ label: parts[i], path: acc });
  }
  if (!isWindows) crumbs.unshift({ label: "/", path: "/" });
  return crumbs;
}

/** The folder that directly contains `fullPath` - used by a row's "Browse
 *  containing folder" action (a file itself has nothing to drill into in
 *  Browse, but the folder around it does). */
function parentPath(fullPath: string, platform: string): string {
  const crumbs = pathSegments(fullPath, platform);
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : crumbs[0]?.path ?? fullPath;
}

/** Copies text to the system clipboard - the same small fallback chain
 *  Breadcrumb.tsx's own copyToClipboard uses (not imported from there:
 *  that component is wired for the file grid's drag targets, which this
 *  view has no other reason to depend on). */
async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to the legacy fallback below
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  } catch {
    // Nothing more to try - silently a no-op, same as Breadcrumb's.
  }
}

// A folder with hundreds of direct children (an actual Downloads folder, a
// cache directory, a mod folder full of small files) still gets one row
// each - that's the whole point of the list layout below, unlike the
// squarified-rectangle version this replaced, where anything past a
// handful of items shrank into illegible slivers. The cap here exists only
// for the truly extreme case (tens of thousands of files in one folder),
// where even cheap flat rows start to add up - the smallest ones fold into
// one "N more items" row sized to their real combined total, so the
// picture's numbers stay honest even where it isn't broken down further.
const MAX_ROWS = 500;

interface RowItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  isOverflow?: boolean;
  overflowCount?: number;
}

function toRowItems(entries: DiskUsageEntry[]): RowItem[] {
  const sorted = [...entries].sort((a, b) => b.size - a.size);
  if (sorted.length <= MAX_ROWS) return sorted;
  const head = sorted.slice(0, MAX_ROWS - 1);
  const tail = sorted.slice(MAX_ROWS - 1);
  const tailSize = tail.reduce((s, e) => s + e.size, 0);
  return [
    ...head,
    {
      name: `${tail.length} more item${tail.length === 1 ? "" : "s"}`,
      path: "",
      is_dir: false,
      size: tailSize,
      isOverflow: true,
      overflowCount: tail.length,
    },
  ];
}

/** Storage breakdown - "This PC" turned into a picture (see diskusage.py):
 *  one row per item in the current folder, largest first, each with a
 *  horizontal bar sized relative to the biggest item here - click a
 *  folder's row to drill into it, the breadcrumb at the top climbs back
 *  out. One level at a time, same lazy design as the backend scan it's
 *  built on - this never asks for the whole drive's tree up front.
 *
 *  This is a deliberate redo of an earlier squarified-rectangle version:
 *  a real folder is rarely an even split - one subfolder (a Steam library,
 *  a single huge video) often dominates, which left every other item as an
 *  unlabeled, unreadable sliver with no name or size visible except on
 *  hover. A row's NAME AND SIZE ARE ALWAYS TEXT, on their own line, never
 *  squeezed to fit inside a shrinking area - the bar underneath is purely
 *  a relative-magnitude cue, not the only thing carrying the information,
 *  so nothing in the current folder is ever unreadable just because one
 *  sibling happens to be huge. */
export function StorageView({
  client,
  rootPath,
  onOpenFile,
  onBrowseFolder,
}: {
  client: BackendClient;
  rootPath: string;
  onOpenFile: (path: string) => void;
  /** Switches the whole app over to the ordinary file browser (Browse
   *  mode) at the given folder - everything this view doesn't do (rename,
   *  move, delete, drag-drop, right-click actions) already exists there,
   *  fully built and tested, for ANY folder on the drive, not just ones
   *  under an indexed root - so rather than reimplementing a second copy
   *  of all of that here, this is the deliberate bridge back to it. See
   *  App.tsx's loadDir. */
  onBrowseFolder: (path: string) => void;
}) {
  const platform = window.smartsearch.platform;
  const [path, setPath] = useState(rootPath);
  const [status, setStatus] = useState<DiskUsageScanStatus | null>(null);
  // What's actually rendered below - only replaced once a scan for the
  // CURRENT path resolves (done or error). Deliberately decoupled from
  // `status` so drilling into a folder that isn't cached yet doesn't blank
  // the whole view to a bare "Scanning..." - the previous folder's rows
  // stay on screen (with a small "Scanning <name>..." indicator folded
  // into the caption) until the new ones are actually ready, closer to how
  // Browse mode never flashes empty between folders.
  const [displayed, setDisplayed] = useState<DiskUsageScanStatus | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; item: RowItem } | null>(null);

  // Re-fetches whenever `path` changes (the initial load, and every
  // drill-in/breadcrumb-out click). `cancelled` guards against a stale
  // response landing after the user has already navigated on past it. A
  // plain path change always reuses a cached scan if one's ready (see
  // main.py's start_disk_usage) - that's what makes App.tsx's startup
  // prewarm of the top level actually feel instant; `force` (the rescan
  // button below) is the one case that deliberately skips the cache.
  const runScan = useCallback(
    (targetPath: string, force: boolean) => {
      let cancelled = false;
      setStatus(null);
      (async () => {
        try {
          let s = await client.startDiskUsageScan(targetPath, force);
          while (!cancelled && s.status === "scanning") {
            await new Promise((resolve) => window.setTimeout(resolve, 300));
            s = await client.diskUsageStatus(targetPath);
          }
          if (!cancelled) {
            setStatus(s);
            setDisplayed(s);
          }
        } catch (err) {
          if (!cancelled) {
            const errStatus: DiskUsageScanStatus = {
              root: targetPath,
              status: "error",
              error: String(err),
              inaccessible: 0,
              entries: [],
            };
            setStatus(errStatus);
            setDisplayed(errStatus);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    },
    [client]
  );

  useEffect(() => runScan(path, false), [runScan, path]);

  // Warms the next level down the moment this one is in hand - the same
  // "scan it before anyone asks" idea App.tsx uses for the drive's top
  // level (see the prewarm effect there), just carried one level deeper
  // every time a folder finishes loading. Fire-and-forget, no polling: a
  // scan that's already running or cached is a no-op on the backend (see
  // start_disk_usage's cache reuse), so this only ever costs anything the
  // first time a given folder is actually seen. Capped and staggered so
  // drilling into something enormous (C:\Windows) doesn't throw dozens of
  // recursive scans at the disk all at once - the biggest children (sorted
  // first by the backend, and the most likely next click in a storage
  // browser) get warmed first.
  useEffect(() => {
    if (!status || status.status !== "done" || status.root !== path) return;
    const PREFETCH_LIMIT = 15;
    const STAGGER_MS = 150;
    const dirs = status.entries.filter((e) => e.is_dir).slice(0, PREFETCH_LIMIT);
    let cancelled = false;
    const timers = dirs.map((d, i) =>
      window.setTimeout(() => {
        if (!cancelled) void client.startDiskUsageScan(d.path).catch(() => {});
      }, i * STAGGER_MS)
    );
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [status, path, client]);

  const items = useMemo(() => (displayed?.status === "done" ? toRowItems(displayed.entries) : []), [displayed]);
  const maxSize = useMemo(() => items.reduce((m, it) => Math.max(m, it.size), 0), [items]);
  const totalSize = useMemo(() => items.reduce((s, it) => s + it.size, 0), [items]);
  const crumbs = useMemo(() => pathSegments(path, platform), [path, platform]);
  // True while the current path's own scan is still in flight but we have
  // something older already on screen to show meanwhile - the case the
  // whole prefetch / stale-while-revalidate setup above exists for.
  const isStale = displayed !== null && (status === null || status.status === "scanning");

  return (
    <div className="storage-view">
      <div className="storage-header">
        <div className="storage-header-row">
          <div className="storage-breadcrumb">
            {crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                {i > 0 && <span className="storage-breadcrumb-sep">/</span>}
                <button
                  className={`storage-breadcrumb-item${i === crumbs.length - 1 ? " storage-breadcrumb-current" : ""}`}
                  onClick={() => setPath(c.path)}
                  disabled={i === crumbs.length - 1}
                  title={c.path}
                >
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="storage-header-actions">
            <button
              className="show-all-toggle"
              onClick={() => runScan(path, true)}
              disabled={status === null || status.status === "scanning"}
              title="Scan this folder again - sizes shown here are from the last scan and don't update on their own if files changed since"
            >
              <IconRefresh size={14} /> Rescan
            </button>
            <button
              className="show-all-toggle"
              onClick={() => onBrowseFolder(path)}
              title="Open this folder in the regular file browser - rename, move, delete and everything else works there"
            >
              Browse this folder
            </button>
          </div>
        </div>
        {displayed?.status === "done" && (
          <div className="storage-caption">
            {items.length} item{items.length === 1 ? "" : "s"} · {formatSize(totalSize)} total
            {displayed.inaccessible > 0 && (
              <span className="storage-caption-warning" title="Some items here couldn't be read (permission denied).">
                <IconWarning size={13} /> {displayed.inaccessible} couldn't be read
              </span>
            )}
            {isStale && (
              <span className="storage-caption-updating" title="Showing the last folder's numbers while this one scans for the first time">
                <span className="storage-caption-spinner" /> Scanning {basename(path) || path}…
              </span>
            )}
          </div>
        )}
      </div>

      <div className={`storage-list${isStale ? " storage-list-loading" : ""}`}>
        {displayed === null ? (
          <div className="storage-status">Scanning {basename(path) || path}…</div>
        ) : displayed.status === "error" && !isStale ? (
          <div className="storage-status storage-status-error">
            <IconWarning size={16} /> Couldn't scan this folder: {displayed.error}
          </div>
        ) : items.length === 0 && !isStale ? (
          <div className="storage-status">This folder is empty.</div>
        ) : (
          items.map((item, i) => {
            const bg = `var(--treemap-${(i % 8) + 1})`;
            const pct = maxSize > 0 && item.size > 0 ? Math.max(1.5, (item.size / maxSize) * 100) : 0;
            const clickableDir = item.is_dir && !item.isOverflow;
            return (
              <div
                key={item.path || `overflow-${i}`}
                className={`storage-row${clickableDir ? " storage-row-clickable" : ""}`}
                onClick={clickableDir ? () => setPath(item.path) : undefined}
                onDoubleClick={!item.is_dir && !item.isOverflow ? () => onOpenFile(item.path) : undefined}
                onContextMenu={
                  item.isOverflow
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        setRowMenu({ x: e.clientX, y: e.clientY, item });
                      }
                }
                title={item.isOverflow ? undefined : item.path}
              >
                {/* The row's color identity - a vertical accent strip,
                   same hue as the magnitude bar below, so "this row's
                   color" and "how big this row's bar is" are visibly the
                   same thing rather than two unrelated colors competing
                   for attention. */}
                <div className="storage-row-accent" style={{ background: bg }} />
                <div className="storage-row-main">
                  <div className="storage-row-info">
                    {!item.isOverflow && (item.is_dir ? <IconFolder size={15} /> : <IconFile size={15} />)}
                    <span className="storage-row-name">{item.name}</span>
                    <span className="storage-row-size">{formatSize(item.size)}</span>
                  </div>
                  <div className="storage-row-track">
                    <div className="storage-row-bar" style={{ width: `${pct}%`, background: bg }} />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={
            rowMenu.item.is_dir
              ? ([
                  {
                    label: "Browse this folder",
                    onClick: () => {
                      onBrowseFolder(rowMenu.item.path);
                      setRowMenu(null);
                    },
                  },
                  {
                    label: "Copy path",
                    onClick: () => {
                      void copyToClipboard(rowMenu.item.path);
                      setRowMenu(null);
                    },
                  },
                ] as ContextMenuItem[])
              : ([
                  {
                    label: "Open file",
                    onClick: () => {
                      onOpenFile(rowMenu.item.path);
                      setRowMenu(null);
                    },
                  },
                  {
                    label: "Browse containing folder",
                    onClick: () => {
                      onBrowseFolder(parentPath(rowMenu.item.path, platform));
                      setRowMenu(null);
                    },
                  },
                  {
                    label: "Copy path",
                    onClick: () => {
                      void copyToClipboard(rowMenu.item.path);
                      setRowMenu(null);
                    },
                  },
                ] as ContextMenuItem[])
          }
        />
      )}
    </div>
  );
}

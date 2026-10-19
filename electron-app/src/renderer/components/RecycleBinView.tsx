import React, { useMemo, useRef, useState } from "react";
import type { RecycleBinEntry, RecycleBinListing } from "../types";
import { IconFolder, IconFile, IconPdf, IconPlay, IconPictures, IconTrash, IconRestore } from "./Icons";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatDeleted(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|webp|tiff?|svg|heic|heif|ico)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|wmv|flv|mpe?g)$/i;

function EntryIcon({ entry }: { entry: RecycleBinEntry }) {
  if (entry.isDirectory) return <IconFolder size={18} />;
  if (/\.pdf$/i.test(entry.name)) return <IconPdf size={18} />;
  if (IMAGE_EXT.test(entry.name)) return <IconPictures size={18} />;
  if (VIDEO_EXT.test(entry.name)) return <IconPlay size={18} />;
  return <IconFile size={18} />;
}

type SortKey = "name" | "originalDir" | "deletedMs" | "size";

/** The app's own view of the Windows Recycle Bin: everything in it, with the
 *  choice to restore or permanently delete some of it - or all of it. */
export function RecycleBinView({
  listing,
  loading,
  busy,
  notice,
  selectedIds,
  onSelectionChange,
  onRestore,
  onDeleteSelected,
  onEmpty,
  onDismissNotice,
}: {
  listing: RecycleBinListing | null;
  loading: boolean;
  /** An action (restore/delete/empty) is running - buttons lock so it can't be fired twice. */
  busy: boolean;
  notice: { kind: "ok" | "error"; text: string } | null;
  selectedIds: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onRestore: () => void;
  onDeleteSelected: () => void;
  onEmpty: () => void;
  onDismissNotice: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("deletedMs");
  const [sortDesc, setSortDesc] = useState(true);
  const anchorRef = useRef<string | null>(null);

  const entries = listing?.entries ?? [];
  const sorted = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    return [...entries].sort((a, b) => {
      let c: number;
      if (sortKey === "name") c = a.name.localeCompare(b.name);
      else if (sortKey === "originalDir") c = a.originalDir.localeCompare(b.originalDir);
      else if (sortKey === "size") c = a.size - b.size;
      else c = a.deletedMs - b.deletedMs;
      return c * dir || a.name.localeCompare(b.name);
    });
  }, [entries, sortKey, sortDesc]);

  const selectedEntries = entries.filter((e) => selectedIds.has(e.id));
  const selectedSize = selectedEntries.reduce((n, e) => n + e.size, 0);
  const allSelected = entries.length > 0 && selectedEntries.length === entries.length;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key === "deletedMs" || key === "size");
    }
  };

  const handleRowClick = (entry: RecycleBinEntry, e: React.MouseEvent) => {
    const next = new Set(selectedIds);
    if (e.shiftKey && anchorRef.current) {
      const a = sorted.findIndex((x) => x.id === anchorRef.current);
      const b = sorted.findIndex((x) => x.id === entry.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(sorted[i].id);
        onSelectionChange(next);
        return;
      }
    }
    if (next.has(entry.id)) next.delete(entry.id);
    else next.add(entry.id);
    anchorRef.current = entry.id;
    onSelectionChange(next);
  };

  const header = (key: SortKey, label: string, className: string) => (
    <button type="button" className={`recycle-th ${className}`} onClick={() => toggleSort(key)}>
      {label}
      {sortKey === key && <span className="recycle-sort">{sortDesc ? " ▼" : " ▲"}</span>}
    </button>
  );

  if (listing && !listing.supported) {
    return (
      <div className="recycle-view">
        <div className="empty-state">
          <div className="empty-state-glyph">
            <IconTrash size={40} />
          </div>
          <div>The Recycle Bin screen is only available on Windows.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="recycle-view">
      <div className="recycle-actions">
        <button
          type="button"
          className="recycle-btn"
          disabled={busy || selectedEntries.length === 0}
          onClick={onRestore}
          title="Put the selected items back where they were deleted from"
        >
          <IconRestore size={15} />
          Restore{selectedEntries.length > 0 ? ` (${selectedEntries.length})` : ""}
        </button>
        <button
          type="button"
          className="recycle-btn recycle-btn-danger"
          disabled={busy || selectedEntries.length === 0}
          onClick={onDeleteSelected}
          title="Permanently delete the selected items - this can't be undone"
        >
          <IconTrash size={15} />
          Delete permanently{selectedEntries.length > 0 ? ` (${selectedEntries.length})` : ""}
        </button>
        <span className="recycle-spacer" />
        <button
          type="button"
          className="recycle-btn recycle-btn-danger-outline"
          disabled={busy || entries.length === 0}
          onClick={onEmpty}
          title="Permanently delete everything in the Recycle Bin - this can't be undone"
        >
          Empty Recycle Bin
        </button>
      </div>

      {notice && (
        <div className={`recycle-notice recycle-notice-${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="recycle-notice-close" onClick={onDismissNotice} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {listing?.error && <div className="recycle-notice recycle-notice-error">{listing.error}</div>}

      {entries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-glyph">
            <IconTrash size={40} />
          </div>
          <div>{loading ? "Loading the Recycle Bin…" : "The Recycle Bin is empty."}</div>
        </div>
      ) : (
        <div className="recycle-table" role="table" aria-label="Recycle Bin">
          <div className="recycle-row recycle-head" role="row">
            <label className="recycle-cell recycle-check">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selectedEntries.length > 0 && !allSelected;
                }}
                onChange={() => onSelectionChange(allSelected ? new Set() : new Set(entries.map((e) => e.id)))}
                aria-label="Select all"
              />
            </label>
            {header("name", "Name", "recycle-col-name")}
            {header("originalDir", "Original location", "recycle-col-loc")}
            {header("deletedMs", "Date deleted", "recycle-col-date")}
            {header("size", "Size", "recycle-col-size")}
          </div>
          <div className="recycle-body">
            {sorted.map((entry) => {
              const selected = selectedIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  className={"recycle-row" + (selected ? " selected" : "")}
                  role="row"
                  aria-selected={selected}
                  onClick={(e) => handleRowClick(entry, e)}
                >
                  <span className="recycle-cell recycle-check">
                    <input
                      type="checkbox"
                      checked={selected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const next = new Set(selectedIds);
                        if (next.has(entry.id)) next.delete(entry.id);
                        else next.add(entry.id);
                        anchorRef.current = entry.id;
                        onSelectionChange(next);
                        void e;
                      }}
                      aria-label={`Select ${entry.name}`}
                    />
                  </span>
                  <span className="recycle-cell recycle-col-name" title={entry.originalPath}>
                    <span className="recycle-icon">
                      <EntryIcon entry={entry} />
                    </span>
                    <span className="recycle-name">{entry.name}</span>
                  </span>
                  <span className="recycle-cell recycle-col-loc" title={entry.originalDir}>
                    {entry.originalDir}
                  </span>
                  <span className="recycle-cell recycle-col-date">{formatDeleted(entry.deletedMs)}</span>
                  <span className="recycle-cell recycle-col-size">{entry.isDirectory && entry.size === 0 ? "" : formatSize(entry.size)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="recycle-footer">
        <span>
          {entries.length} item{entries.length === 1 ? "" : "s"}
          {listing ? ` · ${formatSize(listing.totalSize)}` : ""}
        </span>
        {selectedEntries.length > 0 && (
          <span>
            {selectedEntries.length} selected · {formatSize(selectedSize)}
          </span>
        )}
        <span className="recycle-footer-hint">Tick items to restore or delete some, or use Empty Recycle Bin for all.</span>
      </div>
    </div>
  );
}

import React, { useEffect, useRef } from "react";
import type { GridItem } from "../gridItem";
import { groupByTimeline } from "../gridItem";
import type { SuggestNameResponse } from "../types";
import { FileGrid } from "./FileGrid";
import { IconTimeline } from "./Icons";

export type TimelineKind = "all" | "image" | "video" | "text" | "other";

const CHIPS: { key: TimelineKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "image", label: "Photos" },
  { key: "video", label: "Videos" },
  { key: "text", label: "Documents" },
  { key: "other", label: "Other" },
];

/** Every indexed file, every type, in one newest-first scroll - like a
 *  photos app, not folder-by-folder. Owns no data: App feeds it `items`
 *  (so selection, rename, context menu and drag/drop keep working exactly
 *  as in the normal grid) and is asked for more via `onLoadMore` when the
 *  bottom sentinel scrolls near. */
export function TimelineView({
  items,
  kind,
  onKindChange,
  hasMore,
  loading,
  loaded,
  error,
  hasFolders,
  jumpedLabel,
  showOther,
  onBackToNewest,
  onLoadMore,
  memoriesEnabled,
  onTurnOnMemories,
  topSlot,
  selectedPaths,
  renamingPath,
  onSelect,
  onOpenFile,
  onOpenDirectory,
  onItemContextMenu,
  onBackgroundContextMenu,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onSuggestName,
  onMoveInto,
}: {
  items: GridItem[];
  kind: TimelineKind;
  onKindChange: (k: TimelineKind) => void;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  hasFolders: boolean;
  jumpedLabel: string | null;
  /** Offer the "Other" chip - only meaningful with "Show all files" on. */
  showOther: boolean;
  onBackToNewest: () => void;
  onLoadMore: () => void;
  memoriesEnabled: boolean;
  onTurnOnMemories: () => void;
  topSlot?: React.ReactNode;
  selectedPaths: ReadonlySet<string>;
  renamingPath: string | null;
  onSelect: (item: GridItem | null, e: React.MouseEvent | null) => void;
  onOpenFile: (path: string) => void;
  onOpenDirectory: (path: string) => void;
  onItemContextMenu: (item: GridItem, x: number, y: number) => void;
  onBackgroundContextMenu: (x: number, y: number) => void;
  onStartRename: (item: GridItem) => void;
  onRenameCommit: (item: GridItem, newName: string) => void;
  onRenameCancel: () => void;
  onSuggestName: (item: GridItem) => Promise<SuggestNameResponse>;
  onMoveInto: (paths: string[], destDir: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // Re-created whenever the list grows so that, if the sentinel is still
  // on screen after a page lands (short page, tall window), it fires again
  // and keeps filling until it isn't - IntersectionObserver only reports
  // *changes*, so reusing one observer would stall there.
  useEffect(() => {
    const node = sentinelRef.current;
    const root = scrollRef.current;
    if (!node || !root || !hasMore || loading || error) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { root, rootMargin: "600px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [items.length, hasMore, loading, error]);

  const groups = groupByTimeline(items);

  let body: React.ReactNode;
  if (!hasFolders) {
    body = (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconTimeline size={40} />
        </div>
        <div>Your timeline fills in as folders get indexed.</div>
        <div className="timeline-empty-hint">
          Open a folder like Pictures, Documents or Downloads and search it once - everything in it will then
          appear here.
        </div>
      </div>
    );
  } else if (error && items.length === 0) {
    body = (
      <div className="empty-state">
        <div>Couldn't load the timeline.</div>
        <div className="timeline-empty-hint">{error}</div>
        <button type="button" className="memory-action" onClick={onLoadMore}>
          Try again
        </button>
      </div>
    );
  } else if (loaded && items.length === 0) {
    body = (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconTimeline size={40} />
        </div>
        <div>{kind === "all" ? "Nothing in the timeline yet." : "Nothing of that type yet."}</div>
      </div>
    );
  } else {
    body = (
      <>
        <FileGrid
          items={items}
          grouped={false}
          groups={groups}
          showFolder
          selectedPaths={selectedPaths}
          renamingPath={renamingPath}
          onSelect={onSelect}
          onOpenDirectory={onOpenDirectory}
          onOpenFile={onOpenFile}
          onItemContextMenu={onItemContextMenu}
          onBackgroundContextMenu={onBackgroundContextMenu}
          onStartRename={onStartRename}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
          onSuggestName={onSuggestName}
          onMoveInto={onMoveInto}
        />
        <div ref={sentinelRef} className="timeline-sentinel" aria-hidden="true" />
        <div className="timeline-foot">
          {error ? (
            <>
              Couldn't load more ·{" "}
              <button type="button" className="timeline-link" onClick={onLoadMore}>
                Try again
              </button>
            </>
          ) : loading ? (
            "Loading…"
          ) : hasMore ? (
            ""
          ) : items.length > 0 ? (
            "That's everything in your indexed folders."
          ) : (
            ""
          )}
        </div>
      </>
    );
  }

  return (
    <div className="timeline-view" ref={scrollRef}>
      {topSlot}
      <div className="timeline-header">
        <div className="timeline-chips" role="tablist" aria-label="Filter by type">
          {CHIPS.filter((c) => showOther || c.key !== "other").map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={kind === c.key}
              className={"timeline-chip" + (kind === c.key ? " active" : "")}
              onClick={() => onKindChange(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="timeline-header-right">
          {jumpedLabel && (
            <span className="timeline-jumped">
              Showing from {jumpedLabel} ·{" "}
              <button type="button" className="timeline-link" onClick={onBackToNewest}>
                Back to newest
              </button>
            </span>
          )}
          {!memoriesEnabled && (
            <span className="timeline-jumped">
              Memories are off (they show on Home) ·{" "}
              <button type="button" className="timeline-link" onClick={onTurnOnMemories}>
                Turn on
              </button>
            </span>
          )}
        </div>
      </div>
      {body}
    </div>
  );
}

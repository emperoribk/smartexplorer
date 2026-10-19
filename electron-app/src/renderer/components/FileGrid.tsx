import React, { useEffect, useRef, useState } from "react";
import type { GridItem } from "../gridItem";
import { buildGroups, displayName, fileTypeLabel, formatBytes } from "../gridItem";
import type { SortKey, GroupMode } from "../gridItem";
import { toFileUrl } from "../fileUrl";
import type { SuggestNameResponse } from "../types";
import { TESSERACT_INSTALL_URL } from "../constants";
import { MOVE_PATHS_MIME, readDropPayload } from "../dragDrop";
import { IconFolder, IconFile, IconPdf, IconPackage, IconOther, IconPlay, IconSparkle } from "./Icons";

const PREVIEW_SECONDS = 15;

/** Grid tiles are 108x82 CSS px (see styles.css's .thumb) - this used to
 *  point an <img> straight at the original file, which meant decoding a
 *  full-resolution camera photo just to show it that small, paid again
 *  nearly every time the tile scrolled back into view since nothing cached
 *  the result. That's what made scrolling through a photo-heavy folder
 *  (Downloads being the common case) feel heavy in both directions. Now
 *  requests a small cached thumbnail from the main process first (see
 *  getImageThumbnail in src/main/thumbnails.ts - generated once per file,
 *  reused after that) and only falls back to the original file if that
 *  couldn't be produced, so a real photo is never shown as worse than
 *  before - just usually as a much smaller decode. */
export function ImageTile({ item }: { item: GridItem }) {
  const [thumbPath, setThumbPath] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setThumbPath(null);
    setThumbFailed(false);
    setFailed(false);
    window.smartsearch
      .getImageThumbnail(item.path)
      .then((p) => {
        if (cancelled) return;
        if (p) setThumbPath(p);
        else setThumbFailed(true);
      })
      .catch(() => {
        if (!cancelled) setThumbFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.path]);

  if (failed) return <IconOther size={30} className="tile-icon-glyph" />;

  const src = thumbPath ? toFileUrl(thumbPath) : thumbFailed ? toFileUrl(item.path) : null;
  if (!src) return <span className="tile-icon-spinner" />;

  return (
    <img
      className="thumb-img"
      src={src}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      alt={item.name}
    />
  );
}

/** The hover-to-preview video tile: shows a real frame from the video at
 *  rest (generated and cached in the main process via ffmpeg - see
 *  src/main/thumbnails.ts), then swaps to playing the first 15s, with sound,
 *  looping, while the cursor stays over it. No <video> element is mounted
 *  until hover starts, which keeps a grid full of videos cheap to render -
 *  and means the audio stops the instant the cursor leaves, since the
 *  element itself unmounts rather than just pausing. */
function VideoTile({ item }: { item: GridItem }) {
  const [hovering, setHovering] = useState(false);
  const [posterPath, setPosterPath] = useState<string | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPosterPath(null);
    setPosterFailed(false);
    window.smartsearch
      .getVideoThumbnail(item.path)
      .then((p) => {
        if (cancelled) return;
        if (p) setPosterPath(p);
        else setPosterFailed(true);
      })
      .catch(() => {
        if (!cancelled) setPosterFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.path]);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    if (video.currentTime >= PREVIEW_SECONDS) {
      video.currentTime = 0;
      void video.play();
    }
  };

  return (
    <div
      className="thumb video-thumb"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {hovering ? (
        <video
          className="thumb-video"
          src={toFileUrl(item.path)}
          autoPlay
          playsInline
          onTimeUpdate={handleTimeUpdate}
        />
      ) : posterPath ? (
        <img className="thumb-img" src={toFileUrl(posterPath)} draggable={false} alt={item.name} />
      ) : (
        <div className="video-idle">
          {!posterFailed && <span className="video-idle-spinner" />}
        </div>
      )}
      {!hovering && (
        <>
          <span className="video-play-overlay">
            <IconPlay size={20} className="video-idle-icon" />
          </span>
          <span className="video-badge">VIDEO</span>
        </>
      )}
    </div>
  );
}

/** Small type-identifying chip for kinds that don't get their own thumbnail
 *  (mirrors the VIDEO badge look) - lets someone tell a PDF from an
 *  installer from a plain document at a glance, without reading the
 *  (now-hidden) file extension. */
function TypeBadge({ kind }: { kind: GridItem["kind"] }) {
  if (kind === "pdf") return <span className="type-badge type-badge-pdf">PDF</span>;
  if (kind === "installer") return <span className="type-badge type-badge-installer">APP</span>;
  return null;
}

/** PDF tile: a plain glyph with the small "PDF" badge layered on top.
 *
 *  This used to try rendering an actual thumbnail of the document's first
 *  page via pdfjs-dist, but pdfjs's worker never initialized correctly in
 *  this Electron + Vite setup - every single PDF failed identically and
 *  instantly, regardless of the file - so every tile just spun forever and
 *  fell back to this same glyph anyway, with an extra unnecessary delay.
 *  Reverted to always showing it directly rather than chasing that further -
 *  a plain, reliably-correct icon beats an always-failing "smart" one. */
function PdfTile({ item }: { item: GridItem }) {
  void item; // kept for a consistent Tile-component signature, unused here
  return (
    <div className="thumb tile-icon-relative">
      <IconPdf size={30} className="tile-icon-glyph pdf-glyph" />
      <TypeBadge kind="pdf" />
    </div>
  );
}

/** Fallback tile for every kind that doesn't get a content preview
 *  (installers/apps, plain documents, anything unrecognized) - shows the
 *  file's real OS shell icon (the same one Explorer shows for it) instead
 *  of a generic flat glyph, so nothing in the grid ever looks blank or
 *  boring. Falls back to the plain glyph only if the OS has no icon to
 *  give (rare - e.g. a file that no longer exists by the time this runs). */
function IconThumbTile({ item }: { item: GridItem }) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIconUrl(null);
    setFailed(false);
    window.smartsearch
      .getFileIcon(item.path)
      .then((p) => {
        if (cancelled) return;
        if (p) setIconUrl(toFileUrl(p));
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item.path]);

  // The OS has no icon for this file (rare - genuinely missing, deleted out
  // from under us, or an extension the shell has never seen) - the last
  // resort is a glyph, but a thin gray outline on a gray tile reads as
  // "blank" from a glance, which is exactly what this whole feature is
  // supposed to avoid. Giving it a colored chip backdrop (rough same-family
  // colors Explorer itself uses: blue for documents, blue-gray for
  // installers) means even the worst case still looks like *something*,
  // never an empty square.
  const fallbackGlyph =
    item.kind === "text" ? (
      <span className="icon-fallback-chip icon-fallback-chip-doc">
        <IconFile size={26} className="tile-icon-glyph" />
      </span>
    ) : item.kind === "installer" ? (
      <span className="icon-fallback-chip icon-fallback-chip-installer">
        <IconPackage size={26} className="tile-icon-glyph installer-glyph" />
      </span>
    ) : (
      <span className="icon-fallback-chip icon-fallback-chip-other">
        <IconOther size={26} className="tile-icon-glyph" />
      </span>
    );

  return (
    <div className={`thumb tile-icon${item.kind === "installer" ? " tile-icon-relative" : ""}`}>
      {iconUrl ? (
        <img className="thumb-file-icon" src={iconUrl} draggable={false} alt={item.name} />
      ) : failed ? (
        fallbackGlyph
      ) : (
        <span className="tile-icon-spinner" />
      )}
      {item.kind === "installer" && <TypeBadge kind="installer" />}
    </div>
  );
}

/** Inline rename box that replaces the tile's name label - pre-selects just
 *  the name (not the extension, which stays hidden from editing here the
 *  same way it's hidden from display) so retyping over it doesn't require
 *  retyping ".docx" too.
 *
 *  The "Suggest a name" sparkle button next to it calls onSuggestName (a
 *  read of OCR/extracted text this file already has in the index - see
 *  namegen.py on the backend - not a fresh scan of the file), drops the
 *  result into the field for the person to accept or keep editing, and
 *  never commits anything on its own. */
function RenameInput({
  item,
  onCommit,
  onCancel,
  onSuggestName,
}: {
  item: GridItem;
  onCommit: (item: GridItem, newName: string) => void;
  onCancel: () => void;
  onSuggestName: (item: GridItem) => Promise<SuggestNameResponse>;
}) {
  const [value, setValue] = useState(displayName(item));
  const [suggesting, setSuggesting] = useState(false);
  // Why the last suggestion attempt came back with nothing: "empty" means
  // there's genuinely no usable extracted text (a real dead end - trying
  // again won't help); "ocr_unavailable" means this looks like a scanned
  // file that needs OCR to have any text at all, and Tesseract isn't
  // installed - a *fixable* dead end, so it gets its own message with a
  // link instead of being lumped in with "empty" (see main.py's
  // /suggest-name for how this is decided).
  const [suggestOutcome, setSuggestOutcome] = useState<"empty" | "ocr_unavailable" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestBtnRef = useRef<HTMLButtonElement>(null);
  const settledRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    // React.StrictMode (dev only) double-invokes this effect on first
    // mount - mount, cleanup, mount again - to surface non-idempotent
    // effects. The cleanup below sets unmountedRef so an in-flight
    // suggestion request started before a real unmount can tell and bail
    // out (see handleSuggest). Without resetting it here, that first
    // simulated cleanup leaves it permanently true, so the *real*, live
    // component looks "unmounted" to itself forever and silently drops
    // every suggestion it ever receives, no matter how long the user
    // waits. Production builds don't run StrictMode's double-invoke, so
    // this only ever showed up in dev - which is exactly where it did.
    unmountedRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // The "nothing to suggest from" hint is a quiet, temporary nudge, not a
  // persistent error state - it clears itself so it doesn't sit there
  // looking like a stuck error message. The OCR-specific hint stays up
  // longer: it carries an actual next step (a link), not just a shrug, so
  // it's worth giving the person a moment to actually read and click it.
  useEffect(() => {
    if (!suggestOutcome) return;
    const delay = suggestOutcome === "ocr_unavailable" ? 6000 : 2500;
    const t = window.setTimeout(() => setSuggestOutcome(null), delay);
    return () => window.clearTimeout(t);
  }, [suggestOutcome]);

  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (!commit) {
      onCancel();
      return;
    }
    const trimmed = value.trim();
    const original = displayName(item);
    if (!trimmed || trimmed === original) {
      onCancel();
      return;
    }
    // The extension is hidden from editing here, same as from display - keep
    // the original one unless the person deliberately typed a "." of their
    // own (i.e. they're intentionally changing the extension).
    let finalName = trimmed;
    if (!item.isDirectory) {
      const dot = item.name.lastIndexOf(".");
      if (dot > 0 && !trimmed.includes(".")) {
        finalName = trimmed + item.name.slice(dot);
      }
    }
    onCommit(item, finalName);
  };

  const handleSuggest = async () => {
    setSuggestOutcome(null);
    setSuggesting(true);
    const result = await onSuggestName(item);
    if (unmountedRef.current) return;
    setSuggesting(false);
    if (!result.suggested) {
      setSuggestOutcome(result.reason === "ocr_unavailable" ? "ocr_unavailable" : "empty");
      return;
    }
    // Suggested name comes back with its extension attached (see
    // namegen.py); this field only ever edits the name part, same as
    // anything typed by hand here - settle() reattaches the real extension
    // on commit regardless of what's in the field.
    const suggested = result.suggested;
    const dot = suggested.lastIndexOf(".");
    setValue(dot > 0 ? suggested.slice(0, dot) : suggested);
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  return (
    <div className="tile-rename-row">
      <input
        ref={inputRef}
        className="tile-rename-input"
        value={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") settle(true);
          if (e.key === "Escape") settle(false);
        }}
        onBlur={(e) => {
          // Clicking the suggest button moves focus there first, which
          // fires this blur before the button's own onClick - treating that
          // as "commit and close" would tear down this whole component
          // (and the in-flight suggestion) before it ever got to run.
          if (e.relatedTarget === suggestBtnRef.current) return;
          // A suggestion request can take a moment (it reads OCR/extracted
          // text server-side). If focus leaves the window entirely while
          // it's in flight - clicking elsewhere in the app, alt-tabbing -
          // this blur would otherwise tear the whole box down via
          // settle(true) before the result ever arrives, silently losing
          // it (handleSuggest bails out once unmounted). Let it finish.
          if (suggesting) return;
          // A blur also fires when the whole window loses OS-level focus -
          // switching to another app, a notification stealing focus,
          // opening DevTools - even though nothing inside this app was
          // actually clicked away. Treating that as "commit" is
          // dangerous: it silently renames the file to whatever text
          // happens to be sitting in the box (mid-edit, or leftover from
          // a suggestion that hasn't landed yet). Only settle when focus
          // genuinely moved to something else inside the app itself.
          if (!document.hasFocus()) return;
          settle(true);
        }}
      />
      <button
        ref={suggestBtnRef}
        type="button"
        className="tile-rename-suggest-btn"
        disabled={suggesting}
        title={
          suggestOutcome === "ocr_unavailable"
            ? "This looks like a scanned/photographed file - install Tesseract OCR to suggest a name from it"
            : suggestOutcome === "empty"
              ? "No extracted text to suggest a name from for this file"
              : "Suggest a name from this file's contents"
        }
        // Without this, the mousedown half of the click first shifts focus
        // from the input to this button, which - depending on the browser's
        // click-focus behavior for <button> - can fire the input's blur
        // with a relatedTarget that doesn't match suggestBtnRef (or doesn't
        // fire in the order we'd want at all). That runs settle(true),
        // which tears down this whole RenameInput - button included - before
        // the click's own onClick ever gets a chance to run, so the click
        // silently does nothing. Preventing default on mousedown stops the
        // browser from moving focus off the input in the first place, so no
        // blur happens here and the click always reaches handleSuggest.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          void handleSuggest();
        }}
      >
        <IconSparkle size={12} />
      </button>
      {suggestOutcome === "ocr_unavailable" ? (
        <div className="tile-rename-hint">
          Needs OCR -{" "}
          <button
            type="button"
            className="tile-rename-hint-link"
            // Keeps the rename box open and focused rather than letting this
            // click bubble to the tile underneath (which would just select
            // it, same redundant-click issue the input/suggest button
            // themselves already guard against above).
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              window.smartsearch.openExternal(TESSERACT_INSTALL_URL);
            }}
          >
            install Tesseract
          </button>
        </div>
      ) : (
        suggestOutcome === "empty" && (
          <div className="tile-rename-hint">Nothing to suggest from</div>
        )
      )}
    </div>
  );
}

/** The thumbnail for one item - an image preview, a video poster, a PDF or
 *  OS file icon, or the folder glyph. Shared by the grid tiles and the
 *  details pane so both always show the same thing. */
export function ItemThumb({ item }: { item: GridItem }) {
  if (item.isDirectory) {
    return (
      <div className="thumb tile-icon">
        <IconFolder size={32} className="tile-icon-glyph folder-glyph" />
      </div>
    );
  }
  if (item.kind === "image") {
    return (
      <div className="thumb">
        <ImageTile item={item} />
      </div>
    );
  }
  if (item.kind === "video") return <VideoTile item={item} />;
  if (item.kind === "pdf") return <PdfTile item={item} />;
  return <IconThumbTile item={item} />;
}

function Tile({
  item,
  selected,
  renaming,
  showFolder,
  dragPaths,
  onSelect,
  onOpenDirectory,
  onOpenFile,
  onContextMenu,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onSuggestName,
  onMoveInto,
}: {
  item: GridItem;
  selected: boolean;
  renaming: boolean;
  showFolder: boolean;
  /** What to hand over if this tile is dragged - see FileGrid's own
   *  computation below for why it's not just [item.path]. Empty for a
   *  directory (the vault-lock drop target and plain file moves both only
   *  make sense dragging a file, not a folder), which also turns dragging
   *  off for this tile entirely. */
  dragPaths: string[];
  onSelect: (e: React.MouseEvent) => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (item: GridItem, x: number, y: number) => void;
  onStartRename: () => void;
  onRenameCommit: (item: GridItem, newName: string) => void;
  onRenameCancel: () => void;
  onSuggestName: (item: GridItem) => Promise<SuggestNameResponse>;
  /** Moves the dragged file(s) into this tile's folder when it's a
   *  directory and something gets dropped on it - the FileGrid-internal
   *  half of drag-to-move (Sidebar/Breadcrumb are the other two drop
   *  targets, see App.tsx). */
  onMoveInto: (paths: string[], destDir: string) => void;
}) {
  const [dropHover, setDropHover] = useState(false);

  return (
    <div
      className={`tile${item.isDirectory ? " tile-folder" : ""}${selected ? " tile-selected" : ""}${dropHover ? " tile-drop-hover" : ""}`}
      title={item.path}
      data-path={item.path}
      draggable={dragPaths.length > 0}
      onDragStart={(e) => {
        if (dragPaths.length === 0) {
          e.preventDefault();
          return;
        }
        // Only ever read by a drop target that's looking for this exact
        // type (the vault-lock button, a folder tile, Sidebar, Breadcrumb)
        // - never mistaken for a real OS file drag, which carries a
        // "Files" type instead.
        e.dataTransfer.setData(MOVE_PATHS_MIME, JSON.stringify(dragPaths));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!item.isDirectory || !e.dataTransfer.types.includes(MOVE_PATHS_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropHover(true);
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={(e) => {
        if (!item.isDirectory) return;
        e.preventDefault();
        setDropHover(false);
        const payload = readDropPayload(e);
        if (payload?.kind === "move") onMoveInto(payload.paths, item.path);
      }}
      onClick={onSelect}
      onDoubleClick={() => (item.isDirectory ? onOpenDirectory(item.path) : onOpenFile(item.path))}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // A right-click on an item that's already part of a multi-selection
        // keeps the whole selection (so "Cut"/"Copy"/"Delete" from the menu
        // apply to all of it, same as Explorer) - only replaces the
        // selection with just this item when it wasn't already selected.
        if (!selected) onSelect(e);
        onContextMenu(item, e.clientX, e.clientY);
      }}
    >
      <ItemThumb item={item} />
      <div className="tile-text">
      {renaming ? (
        <RenameInput
          item={item}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
          onSuggestName={onSuggestName}
        />
      ) : (
        <span
          className="tile-name"
          // A plain click on the name itself starts renaming right away - no
          // right-click/context-menu detour needed. Stops the click from
          // also bubbling to the tile's own onClick (which would just
          // (re)select it, redundant here), and selects first so the item
          // renaming applies to is never ambiguous. A Ctrl/Cmd/Shift+click on
          // the name is treated as an ordinary multi-select click instead -
          // someone reaching for the name text while building a selection
          // shouldn't accidentally land in rename mode.
          onClick={(e) => {
            e.stopPropagation();
            onSelect(e);
            if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
              onStartRename();
            }
          }}
        >
          {displayName(item)}
        </span>
      )}
      {!renaming && (
        <span className="tile-meta">
          {item.isDirectory
            ? "Folder"
            : `${fileTypeLabel(item)}${item.size !== undefined ? ` · ${formatBytes(item.size)}` : ""}`}
        </span>
      )}
      {/* Only shown in "search all folders" mode, where results can come
       *  from many different locations and it's not otherwise obvious which -
       *  a single-folder view already says where you are via the breadcrumb. */}
      {!renaming && showFolder && item.folderLabel && (
        <span className="tile-folder-label" title={item.path}>
          {item.folderLabel}
        </span>
      )}
      </div>
    </div>
  );
}

export function FileGrid({
  items,
  grouped,
  groups: customGroups,
  sortKey = "date",
  groupMode = "date",
  selectedPaths,
  renamingPath,
  showFolder = false,
  onSelect,
  onOpenDirectory,
  onOpenFile,
  onItemContextMenu,
  onBackgroundContextMenu,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onSuggestName,
  onMoveInto,
}: {
  items: GridItem[];
  grouped: boolean;
  /** Pre-built sections (e.g. the Timeline's date headings). Overrides
   *  `grouped`; the sections' items must be `items` in the same order. */
  groups?: { label: string; items: GridItem[] }[];
  /** Toolbar's Sort / Group by choices (browse mode only). */
  sortKey?: SortKey;
  groupMode?: GroupMode;
  /** Every currently-selected item's path - a plain click on a tile shows
   *  in here as this Set's sole member, but Ctrl/Cmd+click (toggle) and
   *  Shift+click (range, from the caller's own selection anchor) can grow
   *  it to any number of items, mirroring how a real file explorer's
   *  multi-select works. */
  selectedPaths: ReadonlySet<string>;
  renamingPath: string | null;
  /** Shows a small folder-name caption under each tile - meaningful only in
   *  "search all folders" mode, where results can come from many different
   *  locations at once. Defaults off. */
  showFolder?: boolean;
  /** Fired on every click that changes (or clears) the selection - the
   *  MouseEvent is passed through so the caller can read ctrlKey/metaKey
   *  (toggle) and shiftKey (range-extend) to decide how the selection
   *  should change; `item` is null (with `e` still set, or null for a
   *  purely programmatic clear) when the click was on empty grid space. */
  onSelect: (item: GridItem | null, e: React.MouseEvent | null) => void;
  onOpenDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onItemContextMenu: (item: GridItem, x: number, y: number) => void;
  onBackgroundContextMenu: (x: number, y: number) => void;
  /** A click directly on a tile's name label (as opposed to the tile at
   *  large, or the right-click menu's "Rename") - starts renaming that item
   *  immediately. */
  onStartRename: (item: GridItem) => void;
  onRenameCommit: (item: GridItem, newName: string) => void;
  onRenameCancel: () => void;
  /** Smart auto-naming - see RenameInput's own doc comment. */
  onSuggestName: (item: GridItem) => Promise<SuggestNameResponse>;
  /** A dragged file (or multi-selection) was dropped on a directory tile -
   *  move it there. See Tile's own onMoveInto prop. */
  onMoveInto: (paths: string[], destDir: string) => void;
}) {
  // Fires only for a right-click that wasn't already handled (and stopped)
  // by a tile - i.e. genuinely empty grid space.
  const handleBackgroundContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onSelect(null, e);
    onBackgroundContextMenu(e.clientX, e.clientY);
  };

  if (items.length === 0) {
    return (
      <div className="empty-state" onContextMenu={handleBackgroundContextMenu}>
        <div className="empty-state-glyph">
          <IconFolder size={40} />
        </div>
        <div>Nothing here.</div>
      </div>
    );
  }

  const groups = customGroups ?? (grouped ? buildGroups(items, sortKey, groupMode) : [{ label: "", items }]);

  // What a dragged tile hands the "Your Eyes Only" drop target - the whole
  // current selection (files only; a selected folder is just left out, same
  // as the context menu's "Move to Your Eyes Only" disabling itself for
  // one) when the tile being dragged is part of a multi-selection, mirroring
  // contextMenuTargets' "keep the selection" rule in App.tsx, otherwise just
  // that one file.
  const selectedFilePaths = items.filter((i) => selectedPaths.has(i.path) && !i.isDirectory).map((i) => i.path);

  return (
    <div
      className="file-grid-scroll"
      onClick={(e) => e.currentTarget === e.target && onSelect(null, e)}
      onContextMenu={handleBackgroundContextMenu}
    >
      {groups.map((group) => (
        <div key={group.label || "flat"} className="tile-group">
          {group.label && (
            <div className="tile-group-heading">
              <span>{group.label}</span>
              <span className="tile-group-count">{group.items.length}</span>
            </div>
          )}
          <div className="file-grid">
            {group.items.map((item) => (
              <Tile
                key={item.path}
                item={item}
                selected={selectedPaths.has(item.path)}
                renaming={item.path === renamingPath}
                showFolder={showFolder}
                dragPaths={
                  item.isDirectory
                    ? []
                    : selectedPaths.has(item.path) && selectedFilePaths.length > 1
                      ? selectedFilePaths
                      : [item.path]
                }
                onSelect={(e) => onSelect(item, e)}
                onOpenDirectory={onOpenDirectory}
                onOpenFile={onOpenFile}
                onContextMenu={onItemContextMenu}
                onStartRename={() => onStartRename(item)}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                onSuggestName={onSuggestName}
                onMoveInto={onMoveInto}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

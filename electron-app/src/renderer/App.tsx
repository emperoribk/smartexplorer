import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar, type TabInfo, type TabKind } from "./components/TitleBar";
import { Breadcrumb } from "./components/Breadcrumb";
import { isVaultTempPath, vaultTempRootOf, vaultTopName } from "./vaultTemp";
import { SearchBar } from "./components/SearchBar";
import { FileGrid } from "./components/FileGrid";
import { DuplicatesView } from "./components/DuplicatesView";
import { VaultView, CredentialPrompt } from "./components/VaultView";
import { HomeView } from "./components/HomeView";
import { TimelineView, type TimelineKind } from "./components/TimelineView";
import { MemoriesStrip } from "./components/MemoriesStrip";
import { StorageView } from "./components/StorageView";
import { RecycleBinView } from "./components/RecycleBinView";
import { SettingsView } from "./components/SettingsView";
import { DetailsPane } from "./components/DetailsPane";
import { StatusBar } from "./components/StatusBar";
import { QuickLookOverlay } from "./components/QuickLookOverlay";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { IconEye, IconEyeOff, IconSun, IconMoon, IconX, IconCopyStack, IconHome, IconTimeline, IconTrash, IconSettings, IconSort, IconSidePanel, IconChevronDown } from "./components/Icons";
import {
  applyAccent,
  loadAppearance,
  saveAppearance,
  loadThumbSize,
  loadSimple,
  saveSimple,
  THUMB_SIZE_KEY,
  SHOW_EXT_KEY,
  DETAILS_KEY,
  SORT_KEY,
  GROUP_KEY,
  type Appearance,
  type ThumbSize,
} from "./theme";
import { backendClient, type BackendClient } from "./api";
import type { VaultEntryDragPayload } from "./dragDrop";
import {
  fromDirEntry,
  fromSearchResult,
  fromTimelineItem,
  displayName,
  setShowExtensions,
  type GridItem,
  type SortKey,
  type GroupMode,
} from "./gridItem";
import {
  MEMORIES_ENABLED_KEY,
  SNOOZE_MS,
  loadDismissed,
  saveDismissed,
  visibleCards,
  type DismissedMap,
} from "./memoriesLogic";
import type {
  AutoIndexStatus,
  DiskUsage,
  DuplicatesResponse,
  IndexStatusResponse,
  MemoryCard,
  RecycleBinListing,
  SpecialFolders,
  SuggestNameResponse,
} from "./types";
import { TESSERACT_INSTALL_URL, DEFAULT_VISIBLE_EXTS } from "./constants";

function formatBytes(bytes: number): string {
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

type Mode = "browse" | "search" | "similar" | "duplicates" | "vault" | "home" | "storage" | "timeline" | "recycle" | "settings";

/** Indexing runs on a background thread and only reports progress via
 *  polling (see startIndexing below) - there's no push/webhook - so this
 *  just checks in periodically until it settles. Used before reading
 *  duplicates from the index (see openDuplicates), so the scan reflects
 *  files that were just added/changed rather than a stale snapshot. */
async function waitForIndexDone(client: BackendClient, dir: string): Promise<void> {
  for (;;) {
    const s = await client.indexStatus(dir);
    if (s.status === "done" || s.status === "error" || s.status === "idle") return;
    await new Promise((resolve) => window.setTimeout(resolve, 700));
  }
}
type Theme = "light" | "dark";
type Clipboard = { paths: string[]; mode: "copy" | "cut" };
type ContextMenuState = { x: number; y: number; item: GridItem | null };

const INDEXED_KEY = "smartexplorer.indexedFolders";
// Background indexing of the main folders (see the backend's autoindex.py):
// on by default; DONE is set once the first full pass has finished so the
// sidebar's "Getting your files ready" card only ever shows on first run.
const AUTO_INDEX_KEY = "smartexplorer.autoIndex";
const AUTO_INDEX_DONE_KEY = "smartexplorer.autoIndexDone";
// isVaultTempPath: anything inside the folder the vault decrypts a locked
// folder into (see vaultBridge.ts). Those are browsed like any folder, but must
// not be indexed, remembered in Recent, or searched - they are temporary
// plaintext copies that get deleted when their tab closes - and the real
// location is never shown (see vaultTemp.ts).

const pathKey = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
const RECENT_KEY = "smartexplorer.recentFolders";
const RECENT_FILES_KEY = "smartexplorer.recentFiles";
const SHOW_ALL_FILES_KEY = "smartexplorer.showAllFiles";
const THEME_KEY = "smartexplorer.theme";
const OCR_BANNER_DISMISSED_KEY = "smartexplorer.ocrBannerDismissed";
const MAX_RECENT = 8;
// The Home dashboard's "Recent files" section can comfortably hold more
// than the sidebar's folder list (it's a grid of thumbnails, not a cramped
// nav list), so it gets a more generous cap.
const MAX_RECENT_FILES = 30;

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** The parent directory of a path, as a display-ready string - handles
 *  both POSIX and Windows separators since this only ever feeds UI text
 *  (a recent file's folderLabel/root), never a real filesystem call. */
function dirOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : p;
}

/** Pure range/toggle selection logic shared by mouse clicks (FileGrid, via
 *  handleSelectBrowse/handleSelectHome below) and keyboard arrow navigation
 *  (see the Delete/F2/Ctrl+C/X/Arrow keydown handler) - kept outside the
 *  component so it's trivial to reason about on its own. `flatItems` is
 *  whatever order the current view is actually showing on screen (`items`
 *  for browse/search, `homeRecentItems` for Home) - Shift/Ctrl range-select
 *  walks that same order, so the highlighted range always matches what's
 *  visually between the anchor and the target. */
function nextSelection(
  flatItems: GridItem[],
  prevSelected: GridItem[],
  anchor: string | null,
  item: GridItem,
  extend: boolean,
  toggle: boolean
): { selected: GridItem[]; anchor: string } {
  if (extend && anchor) {
    const anchorIdx = flatItems.findIndex((i) => i.path === anchor);
    const targetIdx = flatItems.findIndex((i) => i.path === item.path);
    if (anchorIdx !== -1 && targetIdx !== -1) {
      const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      return { selected: flatItems.slice(from, to + 1), anchor };
    }
  }
  if (toggle) {
    const exists = prevSelected.some((i) => i.path === item.path);
    const next = exists ? prevSelected.filter((i) => i.path !== item.path) : [...prevSelected, item];
    return { selected: next, anchor: item.path };
  }
  return { selected: [item], anchor: item.path };
}

/** Column count of the file grid currently on screen, measured from the
 *  live DOM rather than tracked in state - the CSS grid's column count is
 *  responsive (window width, sidebar state) and this is only ever read at
 *  the instant an Up/Down arrow key is pressed, so there's nothing to gain
 *  from keeping it in sync proactively. Multiple date-group sub-grids can
 *  be on screen at once (browse mode) - they all share the same column
 *  template, so measuring the first row of the first one is representative.
 *  Falls back to 1 (plain up/down-by-one, like a list) if there's nothing
 *  to measure yet. */
function computeColumnCount(): number {
  const tiles = Array.from(document.querySelectorAll<HTMLElement>(".file-grid .tile"));
  if (tiles.length < 2) return 1;
  const firstTop = tiles[0].offsetTop;
  let count = 0;
  for (const t of tiles) {
    if (t.offsetTop !== firstTop) break;
    count++;
  }
  return Math.max(1, count);
}

function loadTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    // fall through to the system default below
  }
  // No explicit choice saved yet - match the OS's light/dark setting, the
  // same way a real file explorer would, rather than forcing one.
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function loadList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveList(key: string, list: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private/blocked storage - the app still works, it just won't remember
    // pinned/recent folders across restarts.
  }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) === true;
  } catch {
    return fallback;
  }
}

function saveBool(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private/blocked storage - the toggle just won't stick across restarts.
  }
}

export default function App() {
  const [currentDir, setCurrentDir] = useState<string>("");
  const [items, setItems] = useState<GridItem[]>([]);
  const [mode, setMode] = useState<Mode>("browse");
  const [query, setQuery] = useState("");
  // What was actually last searched for - distinct from `query`, which
  // updates on every keystroke. The results banner reads this instead of
  // `query`, so editing the search box after getting results (without
  // pressing Search/Enter again) doesn't relabel the still-displayed old
  // results with whatever text happens to be sitting in the box now.
  const [searchedQuery, setSearchedQuery] = useState("");
  // Short labels for any kind/date filter the natural-language query parser
  // inferred from the last search's phrasing (e.g. ["photos/screenshots",
  // "last week"] for "that ticket screenshot from last week") - shown in
  // the results banner so narrowing is never silent. Empty when nothing was
  // inferred (an ordinary keyword search).
  const [filterLabels, setFilterLabels] = useState<string[]>([]);
  // Which file "Find similar" was last run against - used only to label
  // the results banner ("N items similar to X"), the same way searchedQuery
  // labels a typed search's banner without being read anywhere else.
  const [similarTarget, setSimilarTarget] = useState<GridItem | null>(null);
  const [backendPort, setBackendPort] = useState<number | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [specialFolders, setSpecialFolders] = useState<SpecialFolders | null>(null);
  // Zero, one, or many highlighted items - a plain click (or Enter-less
  // arrow move) collapses this to a single item; Ctrl/Cmd+click toggles one
  // item in or out; Shift+click (or Ctrl/Shift+Arrow) extends a contiguous
  // range from `selectionAnchor`. Mirrors File Explorer's own multi-select
  // model rather than tracking just one "selected" item.
  const [selected, setSelected] = useState<GridItem[]>([]);
  // The item a Shift/Ctrl range-selection extends from - the last item
  // clicked (or arrow-key-navigated to) without a modifier, or the most
  // recent Ctrl-toggle target. Reset alongside `selected` any time the
  // selection itself resets (new folder, new search, Home, etc).
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  // The item Quick Look (Space) is currently showing, or null when it's
  // closed - deliberately its own state rather than piggybacking on
  // `selected`, since Quick Look can page through ArrowLeft/Right to a
  // DIFFERENT item than whatever's highlighted in the grid behind it
  // without disturbing that selection until it actually lands somewhere.
  const [quickLookItem, setQuickLookItem] = useState<GridItem | null>(null);
  // Which page a multi-page PDF is on in Quick Look, and how many pages it
  // has (null until pdfThumbnail's openPdfPreview resolves) - lifted up
  // here, out of QuickLookOverlay/PdfBody, specifically so this keydown
  // handler can decide whether ArrowLeft/Right should turn a PDF page or
  // fall back to switching files (see that branch below) without a second
  // keydown listener down in the overlay - this app deliberately uses a
  // single document-level listener for any Quick-Look-is-modal handling,
  // to avoid the dual-listener conflict ConfirmDialog.tsx already has.
  const [quickLookPdfPage, setQuickLookPdfPage] = useState(1);
  const [quickLookPdfPageCount, setQuickLookPdfPageCount] = useState<number | null>(null);
  // Reset whenever Quick Look lands on a (possibly new) item - covers the
  // initial open, paging to a different file, and closing then reopening.
  useEffect(() => {
    setQuickLookPdfPage(1);
    setQuickLookPdfPageCount(null);
  }, [quickLookItem?.path]);

  // A single Your Eyes Only file opened IN the app: its decrypted temp copy is
  // shown in Quick Look and deleted the moment the preview closes or moves to
  // another file (pressing Open hands it to its default app instead, see
  // handleOpenFile - that path keeps the usual timed cleanup).
  const [vaultPreviewTemp, setVaultPreviewTemp] = useState<string | null>(null);
  const vaultPreviewTempRef = useRef<string | null>(null);
  useEffect(() => {
    vaultPreviewTempRef.current = vaultPreviewTemp;
    if (vaultPreviewTemp && quickLookItem?.path !== vaultPreviewTemp) {
      setVaultPreviewTemp(null);
      vaultPreviewTempRef.current = null;
      void window.smartsearch.releaseVaultTemp(vaultPreviewTemp).catch(() => {});
    }
  }, [quickLookItem, vaultPreviewTemp]);
  const [indexedFolders, setIndexedFolders] = useState<string[]>(() => loadList(INDEXED_KEY));
  const [recentFolders, setRecentFolders] = useState<string[]>(() => loadList(RECENT_KEY));
  const [recentFiles, setRecentFiles] = useState<string[]>(() => loadList(RECENT_FILES_KEY));
  // Resolved (stat'd, kind-sniffed) versions of recentFiles, ready to hand
  // to FileGrid - kept separate from the bare-path list because building it
  // needs an IPC round trip (see loadHomeRecent), not something to redo on
  // every render.
  const [homeRecentItems, setHomeRecentItems] = useState<GridItem[]>([]);
  const [homeRecentLoading, setHomeRecentLoading] = useState(false);
  // --- Recycle Bin screen (Windows) ---
  const [recycleListing, setRecycleListing] = useState<RecycleBinListing | null>(null);
  const [recycleLoading, setRecycleLoading] = useState(false);
  // An action is in flight - locks the buttons so it can't be fired twice.
  const [recycleBusy, setRecycleBusy] = useState(false);
  const [recycleSelected, setRecycleSelected] = useState<Set<string>>(new Set());
  const [recycleNotice, setRecycleNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // --- Timeline + Memories ---
  const [timelineKind, setTimelineKind] = useState<TimelineKind>("all");
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineLoaded, setTimelineLoaded] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  // Epoch seconds the timeline was jumped to ("See in Timeline"), or null
  // when it starts from the newest file.
  const [timelineJump, setTimelineJump] = useState<number | null>(null);
  const timelineCursorRef = useRef<{ before: number | null; beforePath: string | null }>({
    before: null,
    beforePath: null,
  });
  // Bumped on every fresh load so a slow, superseded response is dropped.
  const timelineReqRef = useRef(0);
  const timelineBusyRef = useRef(false);
  const timelineHasMoreRef = useRef(false);
  const [memoriesEnabled, setMemoriesEnabled] = useState<boolean>(() => loadBool(MEMORIES_ENABLED_KEY, true));
  const [memoriesDismissed, setMemoriesDismissed] = useState<DismissedMap>(() => loadDismissed());
  const [memoryCards, setMemoryCards] = useState<MemoryCard[]>([]);
  const memoriesFetchedRef = useRef<{ at: number; key: string } | null>(null);
  const [diskUsage, setDiskUsage] = useState<DiskUsage | null>(null);
  const [showAllFiles, setShowAllFiles] = useState<boolean>(() => loadBool(SHOW_ALL_FILES_KEY, false));
  // Read at call time so a page of results always honors the current
  // "Show all files" setting, not the one from when the callback was made.
  const showAllFilesRef = useRef(showAllFiles);
  useEffect(() => {
    showAllFilesRef.current = showAllFiles;
  }, [showAllFiles]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [convertTargets, setConvertTargets] = useState<string[]>([]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  // Settings > Appearance / Browsing, plus the toolbar's Sort / Group by /
  // Details choices - every one is remembered between launches.
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const [thumbSize, setThumbSize] = useState<ThumbSize>(() => loadThumbSize());
  const [showExtensions, setShowExtensionsState] = useState<boolean>(() => {
    const on = loadBool(SHOW_EXT_KEY, false);
    setShowExtensions(on);
    return on;
  });
  const [autoIndexEnabled, setAutoIndexEnabled] = useState<boolean>(() => loadBool(AUTO_INDEX_KEY, true));
  const [autoIndexStatus, setAutoIndexStatus] = useState<AutoIndexStatus | null>(null);
  const [autoIndexDoneBefore, setAutoIndexDoneBefore] = useState<boolean>(() => loadBool(AUTO_INDEX_DONE_KEY, false));
  const [detailsOpen, setDetailsOpen] = useState<boolean>(() => loadBool(DETAILS_KEY, true));
  const [sortKey, setSortKey] = useState<SortKey>(() => loadSimple(SORT_KEY, ["date", "name", "size"] as const, "date"));
  const [groupMode, setGroupMode] = useState<GroupMode>(() => loadSimple(GROUP_KEY, ["date", "none"] as const, "date"));
  const [viewMenu, setViewMenu] = useState<{ kind: "sort" | "group"; x: number; y: number } | null>(null);
  const [ocrAvailable, setOcrAvailable] = useState<boolean | null>(null);
  const [ocrBannerDismissed, setOcrBannerDismissed] = useState<boolean>(() =>
    loadBool(OCR_BANNER_DISMISSED_KEY, false)
  );
  const [duplicatesData, setDuplicatesData] = useState<DuplicatesResponse | null>(null);
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  // Drives the custom confirm modal (see ConfirmDialog) that replaces
  // window.confirm() for destructive actions - null means no dialog is
  // showing. onConfirm does the actual work and is responsible for closing
  // the dialog itself (setConfirmState(null)) once it's done, so a
  // multi-step confirm (delete, then refresh) doesn't close the dialog
  // early.
  const [confirmState, setConfirmState] = useState<{
    title: string;
    detail?: string;
    danger?: boolean;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);

  // Drives the one-off PIN/Windows-password prompt shown when "Move to
  // Your Eyes Only" (see contextMenuItems below) needs a vault key that
  // isn't already available this session - reuses VaultView's own
  // CredentialPrompt component rather than a second copy of it. null
  // means no prompt is showing. `path` is kept separately (not just
  // re-read from contextMenu, which closes itself on the click that
  // opened this) so the retry after a successful unlock still knows what
  // to lock.
  const [vaultLockPrompt, setVaultLockPrompt] = useState<{ paths: string[]; method: "pin" | "dpapi" } | null>(null);
  const [vaultLockError, setVaultLockError] = useState<string | null>(null);
  const [vaultLockSubmitting, setVaultLockSubmitting] = useState(false);

  // A vault entry (see VaultView.tsx's VaultRow) dragged onto a Sidebar
  // row or Breadcrumb segment, asking to be restored straight there - the
  // STRICT side of the vault asymmetry, so this always asks for a fresh
  // credential, even though lock-dragging above doesn't.
  const [vaultRestoreRequest, setVaultRestoreRequest] = useState<
    { entryId: string; filename: string; destDir: string; method: "pin" | "dpapi"; root?: string } | null
  >(null);
  const [vaultRestoreError, setVaultRestoreError] = useState<string | null>(null);
  const [vaultRestoreSubmitting, setVaultRestoreSubmitting] = useState(false);
  // Highlights the "Your Eyes Only" toolbar button while a dragged file is
  // hovering over it (see that button's onDragOver/onDragLeave below) -
  // purely visual, cleared on drop or on the drag leaving the button.

  // Applied to <html data-theme="..."> - every color in styles.css is a CSS
  // variable keyed off this attribute, so flipping it repaints the whole app.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private/blocked storage - the toggle just won't stick across restarts.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  // The accent color is recomputed whenever the theme or the choice changes
  // (white mode needs a darker shade than dark mode to keep text readable).
  // A layout effect, so a saved accent is in place before the first paint.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    applyAccent(appearance, theme);
  }, [theme, appearance]);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-thumb", thumbSize);
  }, [thumbSize]);

  const changeAppearance = useCallback((next: Appearance) => {
    setAppearance(next);
    saveAppearance(next);
  }, []);

  const changeTheme = useCallback((next: Theme) => setTheme(next), []);

  const changeThumbSize = useCallback((next: ThumbSize) => {
    setThumbSize(next);
    saveSimple(THUMB_SIZE_KEY, next);
  }, []);

  const changeAutoIndex = useCallback((on: boolean) => {
    setAutoIndexEnabled(on);
    saveBool(AUTO_INDEX_KEY, on);
  }, []);

  const changeShowExtensions = useCallback((on: boolean) => {
    setShowExtensions(on);
    setShowExtensionsState(on);
    saveBool(SHOW_EXT_KEY, on);
  }, []);

  const toggleDetails = useCallback(() => {
    setDetailsOpen((prev) => {
      saveBool(DETAILS_KEY, !prev);
      return !prev;
    });
  }, []);

  const openViewMenu = useCallback((kind: "sort" | "group", el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setViewMenu({ kind, x: r.left, y: r.bottom + 4 });
  }, []);

  const viewMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!viewMenu) return [];
    if (viewMenu.kind === "sort") {
      const pick = (k: SortKey) => () => {
        setSortKey(k);
        saveSimple(SORT_KEY, k);
      };
      return [
        { label: "Date modified", checked: sortKey === "date", onClick: pick("date") },
        { label: "Name", checked: sortKey === "name", onClick: pick("name") },
        { label: "Size (largest first)", checked: sortKey === "size", onClick: pick("size") },
      ];
    }
    const pick = (g: GroupMode) => () => {
      setGroupMode(g);
      saveSimple(GROUP_KEY, g);
    };
    return [
      { label: "Date", checked: groupMode === "date", onClick: pick("date") },
      { label: "No grouping", checked: groupMode === "none", onClick: pick("none") },
    ];
  }, [viewMenu, sortKey, groupMode]);

  const clientRef = useRef<BackendClient | null>(null);
  const pollRef = useRef<number | null>(null);
  // Read from inside the indexing-poll interval below, which is recreated
  // only when currentDir changes - refs keep it seeing the latest query/mode
  // without needing to tear the interval down on every keystroke.
  const searchedQueryRef = useRef(searchedQuery);
  const modeRef = useRef(mode);
  const indexedFoldersRef = useRef(indexedFolders);
  useEffect(() => {
    searchedQueryRef.current = searchedQuery;
  }, [searchedQuery]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    indexedFoldersRef.current = indexedFolders;
  }, [indexedFolders]);

  // --- startup: get the OS home dir + special folders, and connect to the backend ---
  useEffect(() => {
    (async () => {
      const home = await window.smartsearch.defaultStartDir();
      setCurrentDir(home);

      const folders = await window.smartsearch.specialFolders();
      setSpecialFolders(folders);

      try {
        setDiskUsage(await window.smartsearch.diskUsage());
      } catch {
        // Not fatal - the sidebar just won't show a disk-space bar.
      }

      const alreadyRunning = await window.smartsearch.getBackendPort();
      if (alreadyRunning) setBackendPort(alreadyRunning);
    })();

    window.smartsearch.onBackendReady((port) => setBackendPort(port));
    window.smartsearch.onBackendError((message) => setBackendError(message));
  }, []);

  useEffect(() => {
    clientRef.current = backendPort ? backendClient(backendPort) : null;
  }, [backendPort]);

  // Once, whenever the backend (re)connects: whether OCR ("find text inside
  // a photo/screenshot") is actually working. Tesseract is a separate
  // native install the person has to do themselves (see README) - it's easy
  // for it to be silently missing, and without this check the only symptom
  // is confusing: search for text that's plainly visible in a screenshot
  // just finds nothing, with no indication why.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    (async () => {
      try {
        const h = await client.health();
        setOcrAvailable(h.ocr_available);
      } catch {
        // Backend not answering yet/transiently - leave unknown, don't nag.
      }
    })();
  }, [backendPort]);

  const dismissOcrBanner = useCallback(() => {
    setOcrBannerDismissed(true);
    saveBool(OCR_BANNER_DISMISSED_KEY, true);
  }, []);

  const rememberRecent = useCallback((dirPath: string) => {
    if (isVaultTempPath(dirPath)) return;
    setRecentFolders((prev) => {
      const next = [dirPath, ...prev.filter((p) => p !== dirPath)].slice(0, MAX_RECENT);
      saveList(RECENT_KEY, next);
      return next;
    });
  }, []);

  // Same idea as rememberRecent, but for individual files that get opened
  // (double-clicked) rather than folders that get browsed into - this is
  // what backs the Home dashboard's "Recent files" section (see HomeView).
  const rememberRecentFile = useCallback((filePath: string) => {
    if (isVaultTempPath(filePath)) return;
    setRecentFiles((prev) => {
      const next = [filePath, ...prev.filter((p) => p !== filePath)].slice(0, MAX_RECENT_FILES);
      saveList(RECENT_FILES_KEY, next);
      return next;
    });
  }, []);

  // --- directory browsing ---
  const loadDir = useCallback(
    async (dirPath: string, showAllOverride?: boolean) => {
      setLoadError(null);
      try {
        const entries = await window.smartsearch.listDir(
          dirPath,
          showAllOverride ?? showAllFiles
        );
        setItems(entries.map(fromDirEntry));
        setCurrentDir(dirPath);
        setMode("browse");
        setQuery("");
        setSearchedQuery("");
        setFilterLabels([]);
        setSelected([]);
        setSelectionAnchor(null);
        rememberRecent(dirPath);
      } catch (err) {
        const message = String(err);
        // A folder that was deleted, renamed or moved outside the app would
        // otherwise sit in the Indexed / Recent lists forever and throw this
        // same error on every click. If that's what happened, say so plainly
        // and drop the dead entry (the folder's index went with it).
        if (/ENOENT|ENOTDIR/.test(message)) {
          const key = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
          const target = key(dirPath);
          const prune = (storageKey: string) => (prev: string[]) => {
            const next = prev.filter((p) => key(p) !== target);
            if (next.length !== prev.length) saveList(storageKey, next);
            return next.length !== prev.length ? next : prev;
          };
          setIndexedFolders(prune(INDEXED_KEY));
          setRecentFolders(prune(RECENT_KEY));
          setLoadError(
            `"${basename(dirPath)}" no longer exists (it was deleted, renamed or moved), so it has been removed from your folder lists.`
          );
          return;
        }
        setLoadError(`Couldn't open ${dirPath}: ${message}`);
      }
    },
    [rememberRecent, showAllFiles]
  );

  const toggleShowAllFiles = useCallback(() => {
    setShowAllFiles((prev) => {
      const next = !prev;
      saveBool(SHOW_ALL_FILES_KEY, next);
      if (mode === "browse" && currentDir) loadDir(currentDir, next);
      return next;
    });
  }, [mode, currentDir, loadDir]);

  useEffect(() => {
    if (currentDir && mode === "browse" && items.length === 0) {
      loadDir(currentDir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDir]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (vaultPreviewTempRef.current === path) {
        // Quick Look's "Open" on a decrypted vault file: hand it to its
        // default app with the timed cleanup instead of deleting it now.
        vaultPreviewTempRef.current = null;
        setVaultPreviewTemp(null);
        void window.smartsearch.openVaultTemp(path).catch(() => {});
        return;
      }
      window.smartsearch.openPath(path);
      rememberRecentFile(path);
    },
    [rememberRecentFile]
  );

  // --- Home dashboard ---
  // Turns the bare recentFiles path list into ready-to-render GridItems
  // (stat'd + kind-sniffed via fs:statPaths - see fsBridge.ts) each time
  // it's needed, rather than keeping GridItems as the source of truth -
  // the bare paths are what's small enough to persist to localStorage, and
  // re-stat'ing on demand means a file's size/thumbnail-kind is always
  // read fresh rather than cached from whenever it was first opened.
  const loadHomeRecent = useCallback(async () => {
    if (recentFiles.length === 0) {
      setHomeRecentItems([]);
      return;
    }
    setHomeRecentLoading(true);
    try {
      const entries = await window.smartsearch.statPaths(recentFiles);
      const found = new Set(entries.map((e) => e.path));
      // A recent file can have been moved/renamed/deleted since it was
      // opened - statPaths just silently drops those, so prune them from
      // the persisted list too instead of trying (and failing) to show
      // them again next time.
      if (found.size !== recentFiles.length) {
        setRecentFiles((prev) => {
          const next = prev.filter((p) => found.has(p));
          saveList(RECENT_FILES_KEY, next);
          return next;
        });
      }
      const order = new Map(recentFiles.map((p, i) => [p, i]));
      const items = entries
        .map((e) => {
          const dir = dirOf(e.path);
          return { ...fromDirEntry(e), folderLabel: basename(dir), root: dir };
        })
        .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
      setHomeRecentItems(items);
    } catch (err) {
      setLoadError(`Couldn't load recent files: ${String(err)}`);
    } finally {
      setHomeRecentLoading(false);
    }
  }, [recentFiles]);

  const goHome = useCallback(() => {
    setMode("home");
    setSelected([]);
    setSelectionAnchor(null);
    setQuery("");
    setSearchedQuery("");
  }, []);

  // Keeps the Home dashboard's recent-files grid in sync with recentFiles
  // - runs once whenever Home is opened, and again whenever the list
  // itself changes while already there (a file gets opened, or
  // loadHomeRecent's own pruning above drops a stale entry).
  useEffect(() => {
    if (mode === "home") void loadHomeRecent();
  }, [mode, recentFiles, loadHomeRecent]);

  // --- timeline ---
  // Loads one page of the timeline. `reset` starts over from the newest
  // file (or from `jumpTo`, epoch seconds, for "See in Timeline"); otherwise
  // it continues from the cursor the previous page left behind. Keyset
  // paging server-side means a reindex between pages can't repeat or skip.
  const loadTimelinePage = useCallback(
    async (reset: boolean, kind: TimelineKind, jumpTo?: number | null) => {
      const client = clientRef.current;
      const roots = indexedFoldersRef.current;
      const req = ++timelineReqRef.current;
      if (reset) {
        timelineCursorRef.current = { before: jumpTo ?? null, beforePath: null };
        timelineHasMoreRef.current = false;
        setTimelineHasMore(false);
        setItems([]);
        setTimelineLoaded(false);
      }
      setTimelineError(null);
      if (!client || roots.length === 0) {
        timelineBusyRef.current = false;
        setTimelineLoading(false);
        setTimelineLoaded(true);
        return;
      }
      timelineBusyRef.current = true;
      setTimelineLoading(true);
      try {
        const cur = timelineCursorRef.current;
        const res = await client.getTimeline(roots, {
          kinds: kind === "all" ? undefined : [kind],
          before: cur.before,
          beforePath: cur.beforePath,
          limit: 120,
          exts: showAllFilesRef.current ? undefined : DEFAULT_VISIBLE_EXTS,
        });
        if (req !== timelineReqRef.current || modeRef.current !== "timeline") return;
        const page = res.items.map(fromTimelineItem);
        timelineCursorRef.current = { before: res.next_before, beforePath: res.next_before_path };
        timelineHasMoreRef.current = res.has_more;
        setTimelineHasMore(res.has_more);
        setItems((prev) => {
          if (reset) return page;
          const have = new Set(prev.map((p) => p.path));
          return prev.concat(page.filter((p) => !have.has(p.path)));
        });
        setTimelineLoaded(true);
      } catch (err) {
        if (req === timelineReqRef.current) {
          setTimelineError(err instanceof Error ? err.message : String(err));
          setTimelineLoaded(true);
        }
      } finally {
        if (req === timelineReqRef.current) {
          timelineBusyRef.current = false;
          setTimelineLoading(false);
        }
      }
    },
    []
  );

  const openTimeline = useCallback(
    (jumpTo?: number) => {
      setMode("timeline");
      setLoadError(null);
      setSelected([]);
      setSelectionAnchor(null);
      setTimelineKind("all");
      setTimelineJump(jumpTo ?? null);
      void loadTimelinePage(true, "all", jumpTo ?? null);
    },
    [loadTimelinePage]
  );

  const loadRecycle = useCallback(async () => {
    setRecycleLoading(true);
    try {
      const listing = await window.smartsearch.recycleList();
      if (modeRef.current !== "recycle") return;
      setRecycleListing(listing);
      // Drop selections for items that are gone (restored/deleted elsewhere).
      setRecycleSelected((prev) => {
        const live = new Set(listing.entries.map((e) => e.id));
        const next = new Set([...prev].filter((id) => live.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      if (modeRef.current !== "recycle") return;
      setRecycleListing({ supported: true, entries: [], totalSize: 0, error: `Couldn't read the Recycle Bin: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setRecycleLoading(false);
    }
  }, []);

  const openSettings = useCallback(() => {
    setMode("settings");
    setLoadError(null);
    setSelected([]);
    setSelectionAnchor(null);
    setQuery("");
    setSearchedQuery("");
  }, []);

  const openRecycleBin = useCallback(() => {
    setMode("recycle");
    setLoadError(null);
    setSelected([]);
    setSelectionAnchor(null);
    setQuery("");
    setSearchedQuery("");
    setRecycleSelected(new Set());
    setRecycleNotice(null);
    void loadRecycle();
  }, [loadRecycle]);

  /** Runs one Recycle Bin action, then reports what happened (including any
   *  items that couldn't be processed) and re-reads the bin. */
  const runRecycleAction = useCallback(
    async (
      action: () => Promise<{ done: number; failed: { id: string; name: string; error: string }[] }>,
      verb: { past: string }
    ) => {
      setRecycleBusy(true);
      setRecycleNotice(null);
      try {
        const res = await action();
        const failedCount = res.failed.length;
        if (failedCount === 0) {
          setRecycleNotice({ kind: "ok", text: `${res.done} item${res.done === 1 ? "" : "s"} ${verb.past}.` });
        } else {
          const first = res.failed[0];
          setRecycleNotice({
            kind: "error",
            text:
              `${res.done} ${verb.past}, ${failedCount} couldn't be processed. ` +
              `${first.name}: ${first.error}` +
              (failedCount > 1 ? ` (and ${failedCount - 1} more)` : ""),
          });
        }
      } catch (err) {
        setRecycleNotice({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setRecycleBusy(false);
        await loadRecycle();
      }
    },
    [loadRecycle]
  );

  const handleRecycleRestore = useCallback(() => {
    const ids = [...recycleSelected];
    if (ids.length === 0) return;
    void runRecycleAction(() => window.smartsearch.recycleRestore(ids), { past: "restored" });
  }, [recycleSelected, runRecycleAction]);

  const handleRecycleDeleteSelected = useCallback(() => {
    const chosen = (recycleListing?.entries ?? []).filter((e) => recycleSelected.has(e.id));
    if (chosen.length === 0) return;
    const ids = chosen.map((e) => e.id);
    const size = chosen.reduce((n, e) => n + e.size, 0);
    setConfirmState({
      title: chosen.length === 1 ? `Permanently delete "${chosen[0].name}"?` : `Permanently delete ${chosen.length} items?`,
      detail: `${formatBytes(size)} will be removed for good. This can't be undone.`,
      danger: true,
      confirmLabel: "Delete permanently",
      onConfirm: () => {
        setConfirmState(null);
        void runRecycleAction(() => window.smartsearch.recycleDelete(ids), { past: "permanently deleted" });
      },
    });
  }, [recycleListing, recycleSelected, runRecycleAction]);

  const handleRecycleEmpty = useCallback(() => {
    const entries = recycleListing?.entries ?? [];
    if (entries.length === 0) return;
    setConfirmState({
      title: "Empty the Recycle Bin?",
      detail: `All ${entries.length} item${entries.length === 1 ? "" : "s"} (${formatBytes(recycleListing?.totalSize ?? 0)}) will be removed for good. This can't be undone.`,
      danger: true,
      confirmLabel: "Empty Recycle Bin",
      onConfirm: () => {
        setConfirmState(null);
        void runRecycleAction(() => window.smartsearch.recycleEmpty(), { past: "permanently deleted" });
      },
    });
  }, [recycleListing, runRecycleAction]);

  const changeTimelineKind = useCallback(
    (kind: TimelineKind) => {
      setTimelineKind(kind);
      setSelected([]);
      setSelectionAnchor(null);
      void loadTimelinePage(true, kind, timelineJump);
    },
    [loadTimelinePage, timelineJump]
  );

  // Scrolling near the bottom, or "Try again" after a failed load.
  const timelineLoadMore = useCallback(() => {
    if (timelineBusyRef.current) return;
    if (timelineError && items.length === 0) {
      void loadTimelinePage(true, timelineKind, timelineJump);
      return;
    }
    if (!timelineHasMoreRef.current) return;
    void loadTimelinePage(false, timelineKind);
  }, [loadTimelinePage, timelineKind, timelineJump, timelineError, items.length]);

  // --- memories (gentle resurfacing) ---
  const loadMemories = useCallback(async () => {
    const client = clientRef.current;
    const roots = indexedFoldersRef.current;
    if (!client || roots.length === 0) {
      setMemoryCards([]);
      return;
    }
    const showAll = showAllFilesRef.current;
    const key = roots.join("|") + (showAll ? "#all" : "#default");
    const fetched = memoriesFetchedRef.current;
    if (fetched && fetched.key === key && Date.now() - fetched.at < 10 * 60_000) return;
    try {
      const res = await client.getMemories(roots, showAll ? undefined : DEFAULT_VISIBLE_EXTS);
      memoriesFetchedRef.current = { at: Date.now(), key };
      setMemoryCards(res.cards);
    } catch {
      // Resurfacing is a nicety - a failure stays quiet rather than nagging.
    }
  }, []);

  useEffect(() => {
    if ((mode === "home" || mode === "timeline") && memoriesEnabled) void loadMemories();
  }, [mode, memoriesEnabled, indexedFolders, backendPort, showAllFiles, loadMemories]);

  // Flipping "Show all files" while on the Timeline re-runs it from the top
  // with the new rule (the browse view does the same in toggleShowAllFiles).
  useEffect(() => {
    if (modeRef.current === "timeline") void loadTimelinePage(true, timelineKind, timelineJump);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAllFiles]);

  const shownMemories = useMemo(
    () => (memoriesEnabled ? visibleCards(memoryCards, memoriesDismissed, recentFolders) : []),
    [memoriesEnabled, memoryCards, memoriesDismissed, recentFolders]
  );

  const dismissMemory = useCallback((id: string) => {
    setMemoriesDismissed((prev) => {
      const next = { ...prev, [id]: Date.now() + SNOOZE_MS };
      saveDismissed(next);
      return next;
    });
  }, []);

  const setMemoriesOn = useCallback((on: boolean) => {
    setMemoriesEnabled(on);
    saveBool(MEMORIES_ENABLED_KEY, on);
  }, []);

  const memoriesStrip =
    shownMemories.length > 0 ? (
      <MemoriesStrip
        cards={shownMemories}
        onOpenFolder={(folder, id) => {
          dismissMemory(id);
          void loadDir(folder);
        }}
        onSeeInTimeline={(date) => openTimeline(date)}
        onDismiss={dismissMemory}
        onTurnOff={() => setMemoriesOn(false)}
      />
    ) : null;

  // --- indexing ---

  // Indexing (and keeping an index fresh) is entirely automatic now - no
  // button anywhere triggers this. runSearch() calls it on every search, and
  // refreshAfterMutation calls it after file actions change an already-
  // indexed folder. Defined here, ahead of refreshAfterMutation below, so
  // that callback can reference it.
  const startIndexing = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !currentDir) return;
    if (isVaultTempPath(currentDir)) return; // never index a decrypted vault copy
    const status = await client.startIndex(currentDir);
    setIndexStatus(status);


    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const s = await client.indexStatus(currentDir);
      setIndexStatus(s);
      // If we're sitting on search results for this same folder, let fresh
      // matches trickle in as indexing progresses instead of making the
      // person re-run the search themselves once it's done. Deliberately
      // re-runs the query that was actually searched (searchedQueryRef),
      // not whatever's currently typed in the box - otherwise editing the
      // search box while a background index is still catching up would
      // silently replace the on-screen results with results for text that
      // was never submitted, while the banner (also keyed off
      // searchedQuery) kept showing the original search.
      if (modeRef.current === "search" && searchedQueryRef.current.trim()) {
        try {
          const response = await client.search(currentDir, searchedQueryRef.current.trim());
          setItems(response.results.map(fromSearchResult));
          setFilterLabels(response.query_info.filter_labels);
        } catch {
          // Transient error mid-index - the next poll tick will retry.
        }
      }
      if (s.status === "done") {
        setIndexedFolders((prev) => {
          if (prev.includes(currentDir)) return prev;
          const next = [currentDir, ...prev];
          saveList(INDEXED_KEY, next);
          return next;
        });
        // Nothing is ever moved into Your Eyes Only automatically any more -
        // only files the person sends there themselves are kept in it.
      }
      // Deliberately not stopping the poll here anymore: the backend now
      // keeps watching this folder live (see watcher.py on the backend,
      // and the "keeps it live" effect below), so status can flip back to
      // "indexing" at any moment - a file dropped in from outside the app,
      // edited, or removed - with nothing here to tell it apart from the
      // one-time initial pass. Polling instead keeps running for as long
      // as this folder stays open, torn down only when leaving it (see
      // the effect below) or on unmount (see the empty-deps effect further
      // down).
    }, 1200);
  }, [currentDir]);

  // --- file management: rename, delete, copy/cut+paste, new folder ---
  const refreshAfterMutation = useCallback(async () => {
    // A rename/delete/etc reachable from the Home dashboard's Recent files
    // grid (see HomeView) shouldn't fall back to loadDir - that would
    // navigate to currentDir's browse view and silently kick the person
    // out of Home. Refresh the recent-files grid itself instead.
    if (mode === "home") {
      await loadHomeRecent();
      return;
    }
    if (mode === "timeline") {
      await loadTimelinePage(true, timelineKind, timelineJump);
      return;
    }
    if (!currentDir) return;
    await loadDir(currentDir);
    // Keep this folder's index current after a change made through the app
    // itself, silently and with no progress UI - only if it was already
    // indexed (nothing to keep fresh in a folder nobody's searched yet).
    // This is cheap: the indexer skips every file whose mtime/size hasn't
    // changed, so re-indexing here mostly amounts to noticing the one file
    // that actually changed.
    if (indexedFoldersRef.current.includes(currentDir)) {
      void startIndexing();
    }
  }, [mode, currentDir, loadDir, startIndexing, loadHomeRecent, loadTimelinePage, timelineKind, timelineJump]);

  // --- selection ---
  // Two thin wrappers around the shared nextSelection() logic above, one
  // per flat item order a FileGrid can currently be showing (browse/search
  // vs. Home's recent-files grid) - Shift/Ctrl range-select needs to walk
  // whichever of those is actually on screen right now.
  const handleSelectBrowse = useCallback(
    (item: GridItem | null, e: React.MouseEvent | null) => {
      if (!item) {
        setSelected([]);
        setSelectionAnchor(null);
        return;
      }
      const toggle = !!e && (e.ctrlKey || e.metaKey);
      const extend = !!e && e.shiftKey;
      const { selected: next, anchor } = nextSelection(items, selected, selectionAnchor, item, extend, toggle);
      setSelected(next);
      setSelectionAnchor(anchor);
    },
    [items, selected, selectionAnchor]
  );

  const handleSelectHome = useCallback(
    (item: GridItem | null, e: React.MouseEvent | null) => {
      if (!item) {
        setSelected([]);
        setSelectionAnchor(null);
        return;
      }
      const toggle = !!e && (e.ctrlKey || e.metaKey);
      const extend = !!e && e.shiftKey;
      const { selected: next, anchor } = nextSelection(
        homeRecentItems,
        selected,
        selectionAnchor,
        item,
        extend,
        toggle
      );
      setSelected(next);
      setSelectionAnchor(anchor);
    },
    [homeRecentItems, selected, selectionAnchor]
  );

  const handleItemContextMenu = useCallback((item: GridItem, x: number, y: number) => {
    setContextMenu({ x, y, item });
  }, []);

  const handleBackgroundContextMenu = useCallback((x: number, y: number) => {
    setContextMenu({ x, y, item: null });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const startRename = useCallback((item: GridItem) => {
    setRenamingPath(item.path);
  }, []);

  const cancelRename = useCallback(() => setRenamingPath(null), []);

  // Smart auto-naming: a filename suggestion built from OCR/extracted text
  // this file already has in the index (see namegen.py) - no new OCR/CLIP
  // work happens on this call. `item.root` covers search results, which can
  // come from a folder other than the one currently open; a plain
  // browse-mode item has no root of its own, so it's always currentDir's.
  const suggestName = useCallback(
    async (item: GridItem): Promise<SuggestNameResponse> => {
      const client = clientRef.current;
      const root = item.root ?? currentDir;
      if (!client || !root) return { suggested: null, reason: null };
      try {
        return await client.suggestName(root, item.path);
      } catch {
        return { suggested: null, reason: null };
      }
    },
    [currentDir]
  );

  const commitRename = useCallback(
    async (item: GridItem, newName: string) => {
      setRenamingPath(null);
      try {
        await window.smartsearch.rename(item.path, newName);
        await refreshAfterMutation();
      } catch (err) {
        setLoadError((err as Error)?.message ?? String(err));
      }
    },
    [refreshAfterMutation]
  );

  const handleConvert = useCallback(
    async (item: GridItem, targetExt: string) => {
      const client = clientRef.current;
      if (!client) return;
      try {
        const result = await client.convertFile(item.path, targetExt);
        await refreshAfterMutation();
        // Only image -> Word is meant to be picked straight back up and
        // typed into (see convert.py's _image_to_docx) - open it in
        // whatever program already handles .docx, same as double-clicking
        // a file. The other conversions just need to show up in the
        // folder; auto-opening every one of them would get in the way of
        // converting several files back to back.
        if (item.kind === "image" && targetExt === ".docx") {
          window.smartsearch.openPath(result.path);
        }
      } catch (err) {
        setLoadError((err as Error)?.message ?? String(err));
      }
    },
    [refreshAfterMutation]
  );

  const handleDelete = useCallback(
    (targetItems: GridItem[]) => {
      if (targetItems.length === 0) return;
      const label =
        targetItems.length === 1
          ? `"${displayName(targetItems[0])}"`
          : `these ${targetItems.length} items`;
      // Deleting is the one action here that can't be casually undone (it
      // moves to the Recycle Bin, not gone outright - but that's still
      // worth a beat of friction), so it goes through the confirm dialog
      // rather than running straight away.
      setConfirmState({
        title: `Move ${label} to the Recycle Bin?`,
        danger: true,
        confirmLabel: "Move to Recycle Bin",
        onConfirm: () => {
          setConfirmState(null);
          void (async () => {
            try {
              await window.smartsearch.deleteItems(targetItems.map((i) => i.path));
              setSelected([]);
              setSelectionAnchor(null);
              await refreshAfterMutation();
            } catch (err) {
              setLoadError((err as Error)?.message ?? String(err));
            }
          })();
        },
      });
    },
    [refreshAfterMutation]
  );

  const handleCopy = useCallback((targetItems: GridItem[]) => {
    if (targetItems.length === 0) return;
    setClipboard({ paths: targetItems.map((i) => i.path), mode: "copy" });
  }, []);

  const handleCut = useCallback((targetItems: GridItem[]) => {
    if (targetItems.length === 0) return;
    setClipboard({ paths: targetItems.map((i) => i.path), mode: "cut" });
  }, []);

  const handlePaste = useCallback(async () => {
    if (!clipboard || !currentDir) return;
    try {
      if (clipboard.mode === "copy") {
        await window.smartsearch.copyItems(clipboard.paths, currentDir);
      } else {
        await window.smartsearch.moveItems(clipboard.paths, currentDir);
        setClipboard(null);
      }
      await refreshAfterMutation();
    } catch (err) {
      setLoadError((err as Error)?.message ?? String(err));
    }
  }, [clipboard, currentDir, refreshAfterMutation]);

  // Drag-and-drop move: a file tile dragged onto a directory tile, a
  // Sidebar entry, or a Breadcrumb segment, all sharing the same
  // MOVE_PATHS_MIME payload (see dragDrop.ts) and landing here.
  const handleMoveTo = useCallback(
    async (paths: string[], destDir: string) => {
      if (paths.length === 0 || !destDir) return;
      try {
        await window.smartsearch.moveItems(paths, destDir);
        await refreshAfterMutation();
      } catch (err) {
        setLoadError((err as Error)?.message ?? String(err));
      }
    },
    [refreshAfterMutation]
  );

  const handleNewFolder = useCallback(async () => {
    if (!currentDir) return;
    try {
      const newPath = await window.smartsearch.newFolder(currentDir);
      await refreshAfterMutation();
      setRenamingPath(newPath); // ready to type a name over "New folder" immediately
    } catch (err) {
      setLoadError((err as Error)?.message ?? String(err));
    }
  }, [currentDir, refreshAfterMutation]);

  // "Compress to ZIP" - plain zip-in, no pre-flight sensitive-content scan
  // (that was floated separately and deliberately deferred; see
  // main/zipBridge.ts's own doc comment). A single item zips to
  // "<name>.zip"; a multi-select zips to "Archive.zip" - same convention
  // Windows' own "Compress to ZIP file" uses for a multi-select.
  const handleZip = useCallback(
    async (targetItems: GridItem[]) => {
      if (targetItems.length === 0 || !currentDir) return;
      const zipBaseName =
        targetItems.length === 1 ? `${displayName(targetItems[0])}.zip` : "Archive.zip";
      try {
        await window.smartsearch.zipItems(targetItems.map((i) => i.path), currentDir, zipBaseName);
        await refreshAfterMutation();
      } catch (err) {
        setLoadError((err as Error)?.message ?? String(err));
      }
    },
    [currentDir, refreshAfterMutation]
  );

  // "Extract" - only ever offered for a single selected .zip file (see
  // contextMenuItems below), into a new folder named after the zip, next
  // to it - never loose into the folder you're already browsing.
  const handleExtractZip = useCallback(
    async (item: GridItem) => {
      try {
        await window.smartsearch.extractZip(item.path);
        await refreshAfterMutation();
      } catch (err) {
        setLoadError((err as Error)?.message ?? String(err));
      }
    },
    [refreshAfterMutation]
  );

  // Delete / F2 / Ctrl+C / Ctrl+X / Ctrl+V / Arrow navigation, ignored while
  // typing anywhere (the search box, the rename box itself, etc).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      // Quick Look is modal while open - it owns every key below rather
      // than letting the grid's own Delete/F2/Arrow handling underneath
      // also react to the same keypress. Arrow keys page to the
      // next/previous item instead of closing, same as Finder's Quick
      // Look; Enter opens the file for real and closes the preview.
      if (quickLookItem) {
        if (e.key === " " || e.key === "Escape") {
          e.preventDefault();
          setQuickLookItem(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          handleOpenFile(quickLookItem.path);
          setQuickLookItem(null);
        } else if (
          (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft") &&
          mode !== "duplicates" &&
          mode !== "vault"
        ) {
          // A focused <video>'s own native Left/Right (seek) and Up/Down
          // (volume, in Chromium's built-in controls) keyboard shortcuts
          // should work normally rather than being hijacked to switch
          // files - only reachable once the user has actually clicked
          // into the video's controls, since autoPlay alone doesn't focus
          // it, so this never affects the common case of just watching.
          if ((e.target as HTMLElement | null)?.tagName === "VIDEO") return;

          // A multi-page PDF has no other keyboard way to turn pages (the
          // pager buttons are mouse-only) - so while one with more than one
          // page is open, Left/Right page through IT instead of jumping to
          // a different file; Up/Down are left alone for file-switching
          // either way, since pages don't have an up/down notion.
          const isPdfPaging =
            (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
            quickLookPdfPageCount !== null &&
            quickLookPdfPageCount > 1;
          if (isPdfPaging) {
            e.preventDefault();
            const delta = e.key === "ArrowRight" ? 1 : -1;
            setQuickLookPdfPage((p) => Math.max(1, Math.min(quickLookPdfPageCount!, p + delta)));
            return;
          }

          e.preventDefault();
          const flat = mode === "home" ? homeRecentItems : items;
          const browsable = flat.filter((i) => !i.isDirectory);
          const idx = browsable.findIndex((i) => i.path === quickLookItem.path);
          if (idx !== -1 && browsable.length > 1) {
            const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
            const nextItem = browsable[(idx + delta + browsable.length) % browsable.length];
            setQuickLookItem(nextItem);
            setSelected([nextItem]);
            setSelectionAnchor(nextItem.path);
          }
        }
        return;
      }

      if (
        e.key === " " &&
        mode !== "recycle" &&
        mode !== "duplicates" &&
        mode !== "vault" &&
        selected.length > 0 &&
        !selected[selected.length - 1].isDirectory
      ) {
        e.preventDefault();
        setQuickLookItem(selected[selected.length - 1]);
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void handlePaste();
        return;
      }

      // Arrow-key grid navigation: plain Arrow moves the highlight to the
      // next item; Ctrl+Arrow or Shift+Arrow extends the highlighted range
      // from the anchor instead (mirrors Ctrl/Shift+click) - Ctrl is what
      // was actually asked for here, Shift is included too since it's the
      // conventional key for this everywhere else. Up/Down use the grid's
      // actual on-screen column count (see computeColumnCount); Left/Right
      // just move by one through the flat item order. Not offered in
      // duplicates mode, which isn't a tile grid.
      const isArrow =
        e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown";
      if (isArrow && mode !== "duplicates" && mode !== "vault" && mode !== "recycle" && mode !== "settings") {
        const flat = mode === "home" ? homeRecentItems : items;
        if (flat.length > 0) {
          e.preventDefault();
          const currentPath = selectionAnchor ?? selected[selected.length - 1]?.path ?? null;
          const currentIdx = currentPath ? flat.findIndex((i) => i.path === currentPath) : -1;
          const cols = e.key === "ArrowUp" || e.key === "ArrowDown" ? computeColumnCount() : 1;
          const delta =
            e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : -cols;
          const nextIdx = Math.max(
            0,
            Math.min(flat.length - 1, currentIdx === -1 ? 0 : currentIdx + delta)
          );
          const nextItem = flat[nextIdx];
          if (nextItem) {
            const extend = e.shiftKey || mod;
            const { selected: next, anchor } = nextSelection(
              flat,
              selected,
              selectionAnchor,
              nextItem,
              extend,
              false
            );
            setSelected(next);
            setSelectionAnchor(anchor);
          }
        }
        return;
      }

      if (selected.length === 0) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void handleDelete(selected);
      } else if (e.key === "F2") {
        // Renaming a whole multi-selection at once isn't meaningful - only
        // offer it when exactly one item is highlighted.
        if (selected.length === 1) {
          e.preventDefault();
          startRename(selected[0]);
        }
      } else if (mod && e.key.toLowerCase() === "c") {
        handleCopy(selected);
      } else if (mod && e.key.toLowerCase() === "x") {
        handleCut(selected);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    selected,
    selectionAnchor,
    mode,
    items,
    homeRecentItems,
    quickLookItem,
    quickLookPdfPageCount,
    handleOpenFile,
    handleDelete,
    startRename,
    handleCopy,
    handleCut,
    handlePaste,
  ]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  // Starts (and keeps alive) live indexing for whatever folder is open in
  // Browse - the moment you navigate into ANY folder, even a brand-new one
  // nobody's ever searched in, this kicks off an initial pass and then
  // keeps watching it in the background for as long as it stays open (see
  // watcher.py): a file added, edited, or removed from outside the app -
  // dragged in via File Explorer, saved by another program, deleted -
  // updates the index without a search or an in-app file action needed to
  // notice it first. Search mode gets its own trigger (see runSearch) since
  // it can fire mid-browse without currentDir changing; this one covers
  // plain navigation, which previously triggered nothing at all.
  useEffect(() => {
    if (mode === "browse" && currentDir) {
      void startIndexing();
    }
  }, [mode, currentDir, backendPort, startIndexing]);

  // --- search ---
  const runSearch = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !currentDir || !query.trim()) return;
    if (isVaultTempPath(currentDir)) {
      setLoadError("Search isn't available inside an unlocked Your Eyes Only folder - it isn't indexed, to keep it private.");
      return;
    }
    setMode("search");
    setLoadError(null);
    setSearching(true);
    setSelected([]);
    setSelectionAnchor(null);
    setSearchedQuery(query.trim());
    try {
      // Searching just works - no separate "index this folder" step required,
      // and no re-index step either: startIndexing runs every search, in the
      // background, and polls index/status so fresh matches trickle in as it
      // goes. For a folder that's never been indexed this is the first pass;
      // for one that's already indexed it's a freshness check that's nearly
      // free (the indexer skips files whose mtime/size haven't changed), so
      // there's nothing to gain by only doing it sometimes. Search is always
      // scoped to the current folder - there's no "search everywhere" mode.
      void startIndexing();
      const response = await client.search(currentDir, query.trim());
      setItems(response.results.map(fromSearchResult));
      setFilterLabels(response.query_info.filter_labels);
    } catch (err) {
      setLoadError(`Search failed: ${String(err)}`);
    } finally {
      setSearching(false);
    }
  }, [currentDir, query, startIndexing]);

  // The search box's own "X": clears the query, and - if a search actually
  // ran - takes the person back to browsing the folder they searched from
  // (same as the "Clear" button on the results banner), rather than just
  // emptying the text box and leaving them stuck looking at stale results.
  // If they'd typed something but not searched yet, there's nothing to
  // leave - just clear the text.
  const clearSearch = useCallback(() => {
    if (mode === "search") {
      loadDir(currentDir);
    } else {
      setQuery("");
    }
  }, [mode, currentDir, loadDir]);

  // "Find similar" - a right-click action on one file (see contextMenuItems
  // below), not a typed query: reuses the exact same results-grid wiring as
  // runSearch (same `items` state, same FileGrid), just fetched from
  // /similar instead of /search, and with its own banner (mode "similar")
  // instead of overwriting whatever a real search was showing.
  const findSimilar = useCallback(
    async (item: GridItem) => {
      const client = clientRef.current;
      if (!client || !currentDir || item.isDirectory) return;
      setMode("similar");
      setLoadError(null);
      setSearching(true);
      setSelected([]);
      setSelectionAnchor(null);
      setSimilarTarget(item);
      try {
        const response = await client.findSimilar(currentDir, item.path);
        setItems(response.results.map(fromSearchResult));
      } catch (err) {
        setLoadError(`Find similar failed: ${String(err)}`);
      } finally {
        setSearching(false);
      }
    },
    [currentDir]
  );

  // --- duplicates ---
  // Entirely a read of the existing index (file hashes + CLIP embeddings,
  // see duplicates.py) - not its own separate scan. Kicks off the same
  // "refresh if anything changed, cheap if not" indexing pass every search
  // already does first, so a file added a moment ago is actually reflected.
  const fetchDuplicates = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !currentDir) return;
    const data = await client.getDuplicates(currentDir);
    setDuplicatesData(data);
  }, [currentDir]);

  const openDuplicates = useCallback(async () => {
    setMode("duplicates");
    setLoadError(null);
    setSelected([]);
    setSelectionAnchor(null);
    setDuplicatesData(null);
    setDuplicatesLoading(true);
    const client = clientRef.current;
    if (!client || !currentDir) {
      setDuplicatesLoading(false);
      return;
    }
    try {
      const status = await client.startIndex(currentDir);
      setIndexStatus(status);
      await waitForIndexDone(client, currentDir);
      await fetchDuplicates();
    } catch (err) {
      setLoadError(`Couldn't scan for duplicates: ${String(err)}`);
    } finally {
      setDuplicatesLoading(false);
    }
  }, [currentDir, fetchDuplicates]);

  // --- "Your Eyes Only" (see vault.py) ---
  // Unlike the removed sensitive-scan button, this toggle doesn't reveal
  // anything by itself - it's the vault's front door, not a report. What's
  // actually inside only shows up after VaultView's own PIN/Windows-
  // password check passes.
  const openVault = useCallback(() => {
    setMode("vault");
    setLoadError(null);
  }, []);

  // --- storage chart ---
  // The sidebar's "This PC" disk-space bar, turned into a picture - see
  // diskusage.py/StorageView.tsx. storagePath is kept separately from
  // currentDir: the storage chart drills into folders of its OWN (any folder on
  // the drive, not just ones opened in Browse), so it needs its own
  // "what's on screen right now" state rather than reusing currentDir.
  const [storagePath, setStoragePath] = useState<string | null>(null);

  const openStorage = useCallback((root: string) => {
    setMode("storage");
    setLoadError(null);
    setStoragePath(root);
  }, []);


  // "Move to Your Eyes Only" - a person's own manual "hide this" choice
  // from the context menu, as opposed to the automatic sensitive-content
  // path (see vault.py's lock_file).
  // Deliberately the LOOSE side of the vault's asymmetry: it only needs a
  // key that's already around this session (set up + unlocked once), not
  // a freshly-retyped PIN/password - that strictness is reserved for
  // getting a file back OUT via VaultView's open/restore. Three outcomes
  // from the backend, each handled differently:
  //   success          -> the file is gone from this folder now; refresh.
  //   "unlock_required" -> ask for the credential once, then retry.
  //   "not_set_up"      -> nothing to lock into yet; offer to open
  //                        "Your Eyes Only" so they can set it up first.
  const attemptLockToVault = useCallback(
    async (paths: string[]) => {
      const client = clientRef.current;
      if (!client || !currentDir || paths.length === 0) return;
      const failed: string[] = [];
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        try {
          await client.lockVaultFile({ rootPath: currentDir, path });
        } catch (err) {
          // unlock_required/not_set_up stop the whole batch right here -
          // whatever's left (this file onward) still needs to happen once
          // that's sorted out, so it's handed to the prompt/dialog as the
          // retry list rather than quietly dropped.
          if (err instanceof Error && err.message === "unlock_required") {
            let method: "pin" | "dpapi" = "pin";
            try {
              const status = await client.getVaultStatus();
              method = status.method === "dpapi" ? "dpapi" : "pin";
            } catch {
              // Fall back to "pin" - the prompt will just say "wrong PIN"
              // instead of "wrong password" if that guess is off, no harm.
            }
            setVaultLockError(null);
            setVaultLockPrompt({ paths: paths.slice(i), method });
            if (i > 0) await refreshAfterMutation();
            return;
          } else if (err instanceof Error && err.message === "not_set_up") {
            const remaining = paths.slice(i);
            setConfirmState({
              title: `"Your Eyes Only" isn't set up yet`,
              detail:
                remaining.length > 1
                  ? `Set it up once and these ${remaining.length} files can be moved in right after.`
                  : "Set it up once and this file can be moved in right after.",
              confirmLabel: "Set up Your Eyes Only",
              onConfirm: () => {
                setConfirmState(null);
                openVault();
              },
            });
            if (i > 0) await refreshAfterMutation();
            return;
          } else {
            failed.push(basename(path));
          }
        }
      }
      setSelected([]);
      setSelectionAnchor(null);
      await refreshAfterMutation();
      if (failed.length > 0) {
        setLoadError(
          failed.length === 1
            ? `Couldn't move "${failed[0]}" to Your Eyes Only.`
            : `Couldn't move ${failed.length} files to Your Eyes Only.`
        );
      }
    },
    [currentDir, refreshAfterMutation, openVault]
  );

  // A vault entry dragged onto a Sidebar row or Breadcrumb segment (see
  // dragDrop.ts's VAULT_ENTRY_MIME) - opens the same fresh-credential
  // prompt VaultView's own Restore button uses, just targeting the
  // dropped-on folder as dest_dir instead of the entry's original one.
  const handleRestoreVaultEntry = useCallback(async (entry: VaultEntryDragPayload, destDir: string) => {
    const client = clientRef.current;
    if (!client) return;
    let method: "pin" | "dpapi" = "pin";
    try {
      const status = await client.getVaultStatus();
      method = status.method === "dpapi" ? "dpapi" : "pin";
    } catch {
      // Fall back to "pin" - same tolerant default as attemptLockToVault
      // above; the prompt just says "wrong PIN" instead of "wrong
      // password" if that guess turns out to be off, no real harm done.
    }
    setVaultRestoreError(null);
    setVaultRestoreRequest({ entryId: entry.entryId, filename: entry.filename, destDir, method, root: entry.root });
  }, []);

  const handleDeleteDuplicates = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      setConfirmState({
        title: `Move ${paths.length} file${paths.length === 1 ? "" : "s"} to the Recycle Bin?`,
        danger: true,
        confirmLabel: "Move to Recycle Bin",
        onConfirm: () => {
          setConfirmState(null);
          void (async () => {
            const client = clientRef.current;
            try {
              await window.smartsearch.deleteItems(paths);
              // The duplicates list comes from the on-disk index (see
              // duplicates.py / getDuplicates), which a plain delete
              // doesn't touch - the file the person just moved to the
              // Recycle Bin still has a row there until something
              // re-indexes. Re-fetching immediately (the old behavior)
              // re-read that stale index and showed the exact same
              // "duplicate" back, making it look like the delete had
              // silently failed even though the file really was gone from
              // disk. Reindexing first - and *waiting* for it to finish,
              // the same way opening this view does - means the list we
              // fetch afterward has actually forgotten the deleted file.
              if (client && currentDir) {
                await client.startIndex(currentDir);
                await waitForIndexDone(client, currentDir);
              }
              await fetchDuplicates();
            } catch (err) {
              setLoadError((err as Error)?.message ?? String(err));
            }
          })();
        },
      });
    },
    [fetchDuplicates, currentDir]
  );

  const platform = window.smartsearch.platform;

  // What a context-menu action should actually apply to: the whole current
  // selection when the right-clicked item is part of it (and there's more
  // than one selected - mirrors Tile's own "keep the selection on
  // right-click" logic in FileGrid), otherwise just the single item that
  // was clicked.
  const contextMenuTargets: GridItem[] = contextMenu?.item
    ? selected.length > 1 && selected.some((i) => i.path === contextMenu.item!.path)
      ? selected
      : [contextMenu.item]
    : [];
  const multiTarget = contextMenuTargets.length > 1;

  // Same selection-or-single-item set as contextMenuTargets - a whole
  // folder is lockable too (vault.py's lock_file zips it into one blob),
  // so nothing is filtered out here anymore. Kept as its own name/variable
  // rather than inlining contextMenuTargets at each call site below, in
  // case a real restriction shows up again later (this mirrored "Find
  // similar"'s files-only restriction before folder support existed).
  const lockableContextTargets = contextMenuTargets;

  // What this file could be converted to (see convertTargets state above) -
  // fetched fresh each time a single file's menu opens rather than derived
  // from its extension here, so the menu only ever offers exactly what the
  // backend (convert.py's supported_targets) will actually accept.
  useEffect(() => {
    const client = clientRef.current;
    const item = contextMenu?.item;
    if (!client || !item || item.isDirectory || multiTarget) {
      setConvertTargets([]);
      return;
    }
    let cancelled = false;
    client
      .convertTargets(item.path)
      .then((r) => {
        if (!cancelled) setConvertTargets(r.targets);
      })
      .catch(() => {
        if (!cancelled) setConvertTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [contextMenu, multiTarget]);

  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? contextMenu.item
      ? [
          {
            label: "Open",
            onClick: () =>
              contextMenu.item!.isDirectory
                ? loadDir(contextMenu.item!.path)
                : handleOpenFile(contextMenu.item!.path),
            disabled: multiTarget,
          },
          {
            label: platform === "darwin" ? "Show in Finder" : "Show in File Explorer",
            onClick: () => window.smartsearch.showInFolder(contextMenu.item!.path),
            disabled: multiTarget,
          },
          {
            label: "Rename",
            onClick: () => startRename(contextMenu.item!),
            separatorBefore: true,
            disabled: multiTarget,
          },
          {
            label: "Find similar",
            onClick: () => void findSimilar(contextMenu.item!),
            disabled: multiTarget || contextMenu.item!.isDirectory,
          },
          {
            label:
              lockableContextTargets.length > 1
                ? `Move ${lockableContextTargets.length} items to Your Eyes Only`
                : "Move to Your Eyes Only",
            onClick: () => void attemptLockToVault(lockableContextTargets.map((i) => i.path)),
            disabled: lockableContextTargets.length === 0,
          },
          ...convertTargets.map((ext, i) => ({
            label: `Convert to ${ext.slice(1).toUpperCase()}`,
            onClick: () => void handleConvert(contextMenu.item!, ext),
            separatorBefore: i === 0,
          })),
          {
            label: multiTarget ? `Compress ${contextMenuTargets.length} items to ZIP` : "Compress to ZIP",
            onClick: () => void handleZip(contextMenuTargets),
            separatorBefore: true,
          },
          ...(!multiTarget && contextMenu.item!.name.toLowerCase().endsWith(".zip")
            ? [{ label: "Extract", onClick: () => void handleExtractZip(contextMenu.item!) }]
            : []),
          {
            label: multiTarget ? `Cut ${contextMenuTargets.length} items` : "Cut",
            onClick: () => handleCut(contextMenuTargets),
            separatorBefore: true,
          },
          {
            label: multiTarget ? `Copy ${contextMenuTargets.length} items` : "Copy",
            onClick: () => handleCopy(contextMenuTargets),
          },
          {
            label: multiTarget ? `Delete ${contextMenuTargets.length} items` : "Delete",
            onClick: () => void handleDelete(contextMenuTargets),
            danger: true,
            separatorBefore: true,
          },
        ]
      : [
          { label: "Paste", onClick: () => void handlePaste(), disabled: !clipboard },
          { label: "New folder", onClick: () => void handleNewFolder(), separatorBefore: true },
        ]
    : [];

  // Every currently-selected item's path, as a Set - what FileGrid/HomeView
  // actually need to know which tiles to highlight. Cheap to rebuild each
  // render (selections are never more than a folder's worth of items).
  const selectedPaths = new Set(selected.map((i) => i.path));

  // VaultView talks to the backend client directly rather than through a
  // pile of callback props (see its own doc comment) - a derived value
  // rather than clientRef's ref, since this one needs to flow into JSX.
  // MUST be memoized on backendPort, not recomputed plainly on every
  // render: VaultView's own refresh() is a useCallback keyed on this
  // object's identity, and App.tsx re-renders constantly (every ~1.2s
  // indexing poll tick, among other things) - a fresh object every render
  // would give refresh() a new identity just as often, retriggering its
  // effect and flashing VaultView's "Checking..." loading state in a
  // loop, which unmounts/remounts VaultSetup and silently resets its
  // in-progress "choose a PIN"/"confirm your Windows password" step back
  // to the start. (This was the setup-never-progresses bug - fixed by
  // memoizing here instead of leaving it a plain derived value.)
  const client = useMemo(() => (backendPort ? backendClient(backendPort) : null), [backendPort]);

  // Warms the drive's top-level scan up FRONT, the moment both the disk
  // root and a working backend connection are known - well before anyone
  // actually clicks "Local Disk" in the sidebar. This is pure head start:
  // the backend caches a finished scan and reuses it on the next
  // /disk-usage/start call for the same path (see main.py), so by the
  // time someone opens the storage chart, the slow part (recursively
  // sizing every top-level folder) has often already happened in the
  // background while they were doing something else - the view just
  // shows the cached result immediately instead of a fresh "Scanning…".
  useEffect(() => {
    if (diskUsage && client) {
      void client.startDiskUsageScan(diskUsage.root);
    }
  }, [diskUsage, client]);

  // --- background indexing of the main folders ---
  // Starts as soon as the backend is up (so right after install nothing has
  // to be indexed by hand), then just polls for progress. Roots are the
  // folders already shown under Pinned.
  const autoIndexRoots = useMemo(
    () =>
      specialFolders
        ? [
            specialFolders.documents,
            specialFolders.pictures,
            specialFolders.desktop,
            specialFolders.downloads,
            specialFolders.videos,
          ].filter(Boolean)
        : [],
    [specialFolders]
  );

  useEffect(() => {
    if (!backendPort || autoIndexRoots.length === 0) return;
    const c = backendClient(backendPort);
    let cancelled = false;
    let timer: number | undefined;
    const apply = (s: AutoIndexStatus) => {
      if (!cancelled) setAutoIndexStatus(s);
    };
    if (autoIndexEnabled) {
      c.autoIndexStart(autoIndexRoots).then(apply).catch(() => {});
      timer = window.setInterval(() => {
        c.autoIndexStatus().then(apply).catch(() => {});
      }, 2500);
    } else {
      c.autoIndexStop().then(apply).catch(() => {});
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [backendPort, autoIndexEnabled, autoIndexRoots]);

  // Folders that have finished indexing join the indexed list, which is what
  // Timeline and Memories read from - so they work straight away too.
  useEffect(() => {
    if (!autoIndexStatus) return;
    const finished = autoIndexStatus.roots.filter((r) => r.status === "done").map((r) => r.root);
    if (finished.length > 0) {
      setIndexedFolders((prev) => {
        const have = new Set(prev.map(pathKey));
        const mine = new Map(autoIndexRoots.map((p) => [pathKey(p), p]));
        const add = finished
          .filter((r) => !have.has(pathKey(r)))
          .map((r) => mine.get(pathKey(r)) ?? r);
        if (add.length === 0) return prev;
        const next = [...prev, ...add];
        saveList(INDEXED_KEY, next);
        return next;
      });
    }
    if (autoIndexStatus.first_pass_done && !autoIndexDoneBefore) {
      setAutoIndexDoneBefore(true);
      saveBool(AUTO_INDEX_DONE_KEY, true);
    }
  }, [autoIndexStatus, autoIndexRoots, autoIndexDoneBefore]);

  const indexProgress =
    autoIndexEnabled &&
    autoIndexStatus &&
    !autoIndexDoneBefore &&
    (autoIndexStatus.state === "indexing" || autoIndexStatus.state === "waiting_model")
      ? {
          waiting: autoIndexStatus.state === "waiting_model",
          folder: autoIndexStatus.current_root ? basename(autoIndexStatus.current_root) : "",
          done: autoIndexStatus.overall_processed,
          total: autoIndexStatus.overall_total,
        }
      : null;

  // Folders already pinned (Documents, Pictures, ...) don't need a second
  // row under "Indexed" just because they are indexed too.
  const sidebarIndexed = useMemo(() => {
    const pinned = new Set(autoIndexRoots.map(pathKey));
    return indexedFolders.filter((p) => !pinned.has(pathKey(p)));
  }, [indexedFolders, autoIndexRoots]);

  // --- tabs (Explorer-style header) ---
  // A tab remembers WHERE it is (a folder, Home, Settings, ...), not its
  // scroll position or selection: switching re-opens that place. The active
  // tab follows whatever the app is showing, so every existing navigation
  // path (sidebar, breadcrumb, double-click) updates its tab for free.
  const [tabs, setTabs] = useState<TabInfo[]>([{ id: 1, kind: "home", dir: "" }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const activeTabIdRef = useRef(1);
  const nextTabIdRef = useRef(2);

  const tabKindForMode = (m: Mode): TabKind | null => {
    switch (m) {
      case "browse":
      case "home":
      case "settings":
      case "timeline":
      case "recycle":
      case "vault":
      case "storage":
        return m;
      default:
        return null; // search / similar / duplicates: the tab keeps its folder
    }
  };

  useEffect(() => {
    const kind = tabKindForMode(mode);
    if (!kind) return;
    const dir = kind === "storage" ? storagePath ?? "" : kind === "browse" ? currentDir : "";
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabIdRef.current && (t.kind !== kind || t.dir !== dir)
          ? { ...t, kind, dir }
          : t
      )
    );
  }, [mode, currentDir, storagePath]);

  const showTab = useCallback(
    (tab: TabInfo) => {
      switch (tab.kind) {
        case "home":
          goHome();
          break;
        case "settings":
          openSettings();
          break;
        case "timeline":
          openTimeline();
          break;
        case "recycle":
          openRecycleBin();
          break;
        case "vault":
          openVault();
          break;
        case "storage":
          if (tab.dir) openStorage(tab.dir);
          else goHome();
          break;
        default:
          if (tab.dir) void loadDir(tab.dir);
          else goHome();
      }
    },
    [goHome, openSettings, openTimeline, openRecycleBin, openVault, openStorage, loadDir]
  );

  const selectTab = useCallback(
    (id: number) => {
      if (id === activeTabIdRef.current) return;
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      activeTabIdRef.current = id;
      setActiveTabId(id);
      showTab(tab);
    },
    [tabs, showTab]
  );

  const newTab = useCallback(() => {
    const id = nextTabIdRef.current++;
    activeTabIdRef.current = id;
    setTabs((prev) => [...prev, { id, kind: "home", dir: "" }]);
    setActiveTabId(id);
    goHome();
  }, [goHome]);

  const closeTab = useCallback(
    (id: number) => {
      if (tabs.length <= 1) {
        window.close(); // last tab closes the window, like Explorer
        return;
      }
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const remaining = tabs.filter((t) => t.id !== id);
      setTabs(remaining);
      if (id === activeTabIdRef.current) {
        const next = remaining[Math.min(idx, remaining.length - 1)];
        activeTabIdRef.current = next.id;
        setActiveTabId(next.id);
        showTab(next);
      }
    },
    [tabs, showTab]
  );

  // --- Your Eyes Only folders, browsed inside the app ---
  // A locked folder is decrypted to a temp folder and opened in a NEW TAB here
  // (never handed to Windows Explorer). The temp folder lives exactly as long
  // as some tab is inside it: once the last one closes or navigates away it is
  // deleted. `seen` guards the gap between creating the tab and the tab
  // actually reporting its folder, so it isn't released before it was shown.
  const vaultTempsRef = useRef<Map<string, { seen: boolean }>>(new Map());

  const openVaultFolder = useCallback(
    async (tempPath: string, _name: string) => {
      vaultTempsRef.current.set(tempPath, { seen: false });
      const id = nextTabIdRef.current++;
      activeTabIdRef.current = id;
      setTabs((prev) => [...prev, { id, kind: "browse", dir: tempPath }]);
      setActiveTabId(id);
      await loadDir(tempPath);
    },
    [loadDir]
  );

  // Folders handed to Your Eyes Only so it can find every vault, not only the
  // open folder's. Joined into one string so the list is stable between renders.
  const vaultFoldersKey = [...indexedFolders, ...recentFolders].join("\n");
  const vaultKnownFolders = useMemo(
    () => Array.from(new Set(vaultFoldersKey.split("\n").filter((p) => p && !isVaultTempPath(p)))),
    [vaultFoldersKey]
  );

  const openVaultFileInApp = useCallback(async (tempPath: string, name: string): Promise<boolean> => {
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
    const IMAGE = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico"];
    const VIDEO = [".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"];
    const TEXT = [".txt", ".md", ".csv", ".log", ".json", ".xml", ".yaml", ".yml", ".ini", ".docx"];
    let kind: GridItem["kind"] | null = null;
    if (IMAGE.includes(ext)) kind = "image";
    else if (VIDEO.includes(ext)) kind = "video";
    else if (ext === ".pdf") kind = "pdf";
    else if (TEXT.includes(ext)) kind = "text";
    if (!kind) return false; // nothing in-app can show it: caller opens it normally
    setVaultPreviewTemp(tempPath);
    vaultPreviewTempRef.current = tempPath;
    setQuickLookItem({ path: tempPath, name, isDirectory: false, kind });
    return true;
  }, []);

  useEffect(() => {
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    vaultTempsRef.current.forEach((state, root) => {
      const r = norm(root);
      const inside = tabs.some((t) => {
        if (t.kind !== "browse" || !t.dir) return false;
        const d = norm(t.dir);
        return d === r || d.startsWith(r + "\\") || d.startsWith(r + "/");
      });
      if (inside) {
        state.seen = true;
      } else if (state.seen) {
        vaultTempsRef.current.delete(root);
        void window.smartsearch.releaseVaultTemp(root).catch(() => {});
      }
    });
  }, [tabs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        newTab();
      } else if (k === "w") {
        e.preventDefault();
        closeTab(activeTabIdRef.current);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === activeTabIdRef.current);
        const n = tabs.length;
        const target = tabs[(i + (e.shiftKey ? n - 1 : 1)) % n];
        if (target) selectTab(target.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tabs, newTab, closeTab, selectTab]);

  // The details panel only makes sense where a file can be selected.
  const detailsAvailable = mode === "browse" || mode === "search" || mode === "similar" || mode === "timeline";

  return (
    <div className="app">
      <TitleBar
        tabs={tabs}
        activeId={activeTabId}
        theme={theme}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
      />
      <div className="app-body">
      <Sidebar
        specialFolders={specialFolders}
        currentDir={currentDir}
        onNavigate={loadDir}
        onPickFolder={async () => {
          const dir = await window.smartsearch.pickFolder();
          if (dir) loadDir(dir);
        }}
        indexedFolders={sidebarIndexed}
        indexProgress={indexProgress}
        recentFolders={recentFolders.filter(
          (p) => p !== currentDir && !indexedFolders.includes(p)
        )}
        onHome={goHome}
        homeActive={mode === "home"}
        diskUsage={diskUsage}
        onMoveInto={handleMoveTo}
        onRestoreVaultEntry={handleRestoreVaultEntry}
        onOpenVault={() => (mode === "vault" ? loadDir(currentDir) : openVault())}
        vaultActive={mode === "vault"}
        onLockToVault={(paths) => void attemptLockToVault(paths)}
        onOpenTimeline={() => (mode === "timeline" ? loadDir(currentDir) : openTimeline())}
        timelineActive={mode === "timeline"}
        onOpenRecycleBin={() => (mode === "recycle" ? loadDir(currentDir) : openRecycleBin())}
        recycleActive={mode === "recycle"}
        onOpenStorage={(root) => (mode === "storage" ? loadDir(currentDir) : openStorage(root))}
        storageActive={mode === "storage"}
        onOpenSettings={() => (mode === "settings" ? loadDir(currentDir) : openSettings())}
        settingsActive={mode === "settings"}
      />

      <div className="main-pane">
        <div className="toolbar">
          {mode === "home" || mode === "timeline" || mode === "recycle" || mode === "settings" ? (
            <div className="breadcrumb-home-label">
              {mode === "home" ? (
                <IconHome size={15} />
              ) : mode === "recycle" ? (
                <IconTrash size={15} />
              ) : mode === "settings" ? (
                <IconSettings size={15} />
              ) : (
                <IconTimeline size={15} />
              )}
              <span>
                {mode === "home" ? "Home" : mode === "recycle" ? "Recycle Bin" : mode === "settings" ? "Settings" : "Timeline"}
              </span>
            </div>
          ) : (
            <Breadcrumb
                path={currentDir}
                platform={platform}
                onNavigate={loadDir}
                onMoveInto={handleMoveTo}
                onRestoreVaultEntry={handleRestoreVaultEntry}
                onOpenVault={openVault}
              />
          )}
          {mode !== "duplicates" &&
            mode !== "vault" &&
            mode !== "home" &&
            mode !== "timeline" &&
            mode !== "recycle" &&
            mode !== "settings" &&
            !isVaultTempPath(currentDir) && (
              <SearchBar
                query={query}
                onQueryChange={setQuery}
                onSubmit={runSearch}
                onClear={clearSearch}
                indexStatus={indexStatus}
                searching={searching}
                folderLabel={basename(currentDir)}
              />
            )}
          {detailsAvailable && (
            <button
              type="button"
              className={`icon-toggle-btn${detailsOpen ? " icon-toggle-btn-active" : ""}`}
              onClick={toggleDetails}
              aria-pressed={detailsOpen}
              aria-label={detailsOpen ? "Hide the details panel" : "Show the details panel"}
              title={detailsOpen ? "Hide the details panel" : "Show the details panel"}
            >
              <IconSidePanel size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-toggle-btn"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
          </button>
        </div>

        {mode !== "home" && mode !== "recycle" && mode !== "settings" && (
          <div className="toolbar-bar">
            {mode === "browse" && (
              <>
                <button
                  type="button"
                  className="toolbar-chip"
                  onClick={(e) => openViewMenu("sort", e.currentTarget)}
                  title="Choose how files are ordered"
                >
                  <IconSort size={15} />
                  <span>
                    Sort <b>{sortKey === "date" ? "Date" : sortKey === "name" ? "Name" : "Size"}</b>
                  </span>
                  <IconChevronDown size={12} />
                </button>
                <button
                  type="button"
                  className="toolbar-chip"
                  onClick={(e) => openViewMenu("group", e.currentTarget)}
                  title="Choose how files are grouped"
                >
                  <span>
                    Group by <b>{groupMode === "date" ? "Date" : "None"}</b>
                  </span>
                  <IconChevronDown size={12} />
                </button>
              </>
            )}
            <span className="toolbar-bar-spacer" />
            <button
              type="button"
              className={`show-all-toggle${showAllFiles ? " show-all-toggle-active" : ""}`}
              onClick={toggleShowAllFiles}
              title={
                showAllFiles
                  ? "Showing every file, including shortcuts and system files. Click to hide them again."
                  : "Only showing photos, videos, PDFs, documents and installers. Click to show every file."
              }
            >
              {showAllFiles ? <IconEye size={15} /> : <IconEyeOff size={15} />}
              <span>{showAllFiles ? "Showing all files" : "Show all files"}</span>
            </button>
            <button
              type="button"
              className={`show-all-toggle${mode === "duplicates" ? " show-all-toggle-active" : ""}`}
              onClick={() => (mode === "duplicates" ? loadDir(currentDir) : openDuplicates())}
              title="Find duplicate and near-duplicate files in this folder"
            >
              <IconCopyStack size={15} />
              <span>{mode === "duplicates" ? "Back to files" : "Find duplicates"}</span>
            </button>
          </div>
        )}

        {!backendPort && !backendError && (
          <div className="status-banner">Starting local search engine…</div>
        )}
        {backendError && (
          <div className="status-banner status-error">
            Search backend failed to start: {backendError}. Browsing still works; see the README
            to fix the Python setup.
          </div>
        )}
        {ocrAvailable === false && !ocrBannerDismissed && (
          <div className="status-banner">
            Search can't find text inside photos/screenshots yet - that needs Tesseract OCR,
            which isn't installed on this computer. Everything else (names, document text, and
            finding images by what's in them) still works.
            <button
              className="status-banner-link"
              onClick={() => window.smartsearch.openExternal(TESSERACT_INSTALL_URL)}
            >
              Install Tesseract
            </button>
            <button className="status-banner-dismiss" onClick={dismissOcrBanner} aria-label="Dismiss">
              <IconX size={12} />
            </button>
          </div>
        )}
        {searching && mode === "similar" && (
          <div className="status-banner">Finding similar files…</div>
        )}
        {searching && mode !== "similar" && (
          <div className="status-banner">
            Searching… the very first search after install can take a few minutes, while some
            local search components download in the background. That only happens once.
          </div>
        )}
        {!searching && mode === "search" && (
          <div className="status-banner">
            {indexStatus?.status === "indexing" ? (
              items.length === 0 ? (
                <>
                  Scanning this folder for the first time ({indexStatus.processed}/
                  {indexStatus.total} files) — matches will start appearing automatically as it
                  goes…
                </>
              ) : (
                <>
                  {items.length} result{items.length === 1 ? "" : "s"} so far for “{searchedQuery}”
                  — still indexing ({indexStatus.processed}/{indexStatus.total}), more may appear…
                </>
              )
            ) : items.length === 0 ? (
              <>No results for “{searchedQuery}”.</>
            ) : (
              <>
                {items.length} result{items.length === 1 ? "" : "s"} for “{searchedQuery}”
              </>
            )}
            {filterLabels.length > 0 && (
              <span className="search-filter-note" title="Detected from how the search was phrased">
                filtered to: {filterLabels.join(", ")}
              </span>
            )}
            <button className="clear-search" onClick={() => loadDir(currentDir)}>
              Clear
            </button>
          </div>
        )}
        {!searching && mode === "similar" && (
          <div className="status-banner">
            {items.length === 0 ? (
              <>Nothing else looks related to &ldquo;{similarTarget?.name ?? ""}&rdquo;.</>
            ) : (
              <>
                {items.length} item{items.length === 1 ? "" : "s"} similar to &ldquo;
                {similarTarget?.name ?? ""}&rdquo;
              </>
            )}
            <button className="clear-search" onClick={() => loadDir(currentDir)}>
              Clear
            </button>
          </div>
        )}
        {loadError && <div className="status-banner status-error">{loadError}</div>}
        {mode === "browse" && vaultTempRootOf(currentDir) && (
          <div className="status-banner vault-sandbox-banner">
            <span>
              Viewing "{vaultTopName(currentDir)}" from Your Eyes Only. This is a temporary copy - changes made here
              aren't saved back, and it's deleted when you leave. Restore it from Your Eyes Only to put it back in
              its original folder.
            </span>
            <button type="button" className="vault-lock-now-btn" onClick={openVault}>
              Back to Your Eyes Only
            </button>
          </div>
        )}

        {mode === "duplicates" ? (
          <DuplicatesView
            currentDir={currentDir}
            loading={duplicatesLoading}
            data={duplicatesData}
            onDeleteSelected={handleDeleteDuplicates}
          />
        ) : mode === "vault" ? (
          client && <VaultView currentDir={isVaultTempPath(currentDir) ? "" : currentDir} knownFolders={vaultKnownFolders} client={client} onOpenFolder={openVaultFolder} onOpenFile={openVaultFileInApp} />
        ) : mode === "storage" ? (
          client && storagePath && (
            <StorageView
              key={storagePath}
              client={client}
              rootPath={storagePath}
              onOpenFile={handleOpenFile}
              onBrowseFolder={loadDir}
            />
          )
        ) : mode === "recycle" ? (
          <RecycleBinView
            listing={recycleListing}
            loading={recycleLoading}
            busy={recycleBusy}
            notice={recycleNotice}
            selectedIds={recycleSelected}
            onSelectionChange={setRecycleSelected}
            onRestore={handleRecycleRestore}
            onDeleteSelected={handleRecycleDeleteSelected}
            onEmpty={handleRecycleEmpty}
            onDismissNotice={() => setRecycleNotice(null)}
          />
        ) : mode === "settings" ? (
          <SettingsView
            theme={theme}
            onThemeChange={changeTheme}
            appearance={appearance}
            onAppearanceChange={changeAppearance}
            thumbSize={thumbSize}
            onThumbSizeChange={changeThumbSize}
            showExtensions={showExtensions}
            onShowExtensionsChange={changeShowExtensions}
            autoIndexEnabled={autoIndexEnabled}
            onAutoIndexChange={changeAutoIndex}
            autoIndexStatus={autoIndexStatus}
          />
        ) : mode === "timeline" ? (
          <TimelineView
            items={items}
            kind={timelineKind}
            onKindChange={changeTimelineKind}
            hasMore={timelineHasMore}
            loading={timelineLoading}
            loaded={timelineLoaded}
            error={timelineError}
            hasFolders={indexedFolders.length > 0}
            showOther={showAllFiles}
            jumpedLabel={
              timelineJump !== null
                ? new Date(timelineJump * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" })
                : null
            }
            onBackToNewest={() => {
              setTimelineJump(null);
              void loadTimelinePage(true, timelineKind, null);
            }}
            onLoadMore={timelineLoadMore}
            memoriesEnabled={memoriesEnabled}
            onTurnOnMemories={() => setMemoriesOn(true)}
            selectedPaths={selectedPaths}
            renamingPath={renamingPath}
            onSelect={handleSelectBrowse}
            onOpenFile={handleOpenFile}
            onOpenDirectory={loadDir}
            onItemContextMenu={handleItemContextMenu}
            onBackgroundContextMenu={handleBackgroundContextMenu}
            onStartRename={startRename}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            onSuggestName={suggestName}
            onMoveInto={handleMoveTo}
          />
        ) : mode === "home" ? (
          <HomeView
            topSlot={memoriesStrip}
            specialFolders={specialFolders}
            indexedFolders={indexedFolders}
            recentFolders={recentFolders}
            recentItems={homeRecentItems}
            recentLoading={homeRecentLoading}
            onNavigate={loadDir}
            selectedPaths={selectedPaths}
            renamingPath={renamingPath}
            onSelect={handleSelectHome}
            onOpenFile={handleOpenFile}
            onItemContextMenu={handleItemContextMenu}
            onBackgroundContextMenu={() => {}}
            onStartRename={startRename}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            onSuggestName={suggestName}
            onMoveInto={handleMoveTo}
          />
        ) : (
          <FileGrid
            items={items}
            grouped={mode === "browse"}
            sortKey={sortKey}
            groupMode={groupMode}
            selectedPaths={selectedPaths}
            renamingPath={renamingPath}
            onSelect={handleSelectBrowse}
            onOpenDirectory={loadDir}
            onOpenFile={handleOpenFile}
            onItemContextMenu={handleItemContextMenu}
            onBackgroundContextMenu={handleBackgroundContextMenu}
            onStartRename={startRename}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            onSuggestName={suggestName}
            onMoveInto={handleMoveTo}
          />
        )}

        {mode !== "duplicates" && mode !== "vault" && mode !== "home" && mode !== "recycle" && mode !== "settings" && (
          <StatusBar itemCount={items.length} selected={selected} />
        )}
      </div>

      {detailsAvailable && detailsOpen && (
        <DetailsPane
          selected={selected}
          onOpenFile={handleOpenFile}
          onOpenDirectory={loadDir}
          onStartRename={startRename}
          onRenameCommit={commitRename}
          onSuggestName={suggestName}
          onDelete={handleDelete}
          onClose={toggleDetails}
        />
      )}

      {viewMenu && (
        <ContextMenu x={viewMenu.x} y={viewMenu.y} items={viewMenuItems} onClose={() => setViewMenu(null)} />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          detail={confirmState.detail}
          danger={confirmState.danger}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {vaultLockPrompt && (
        <CredentialPrompt
          method={vaultLockPrompt.method}
          title="Unlock Your Eyes Only"
          detail="Needed once to start moving files in this session - it won't ask again until the app restarts or you lock it."
          confirmLabel="Unlock"
          submitting={vaultLockSubmitting}
          error={vaultLockError}
          onSubmit={(value) => {
            const target = vaultLockPrompt;
            const client = clientRef.current;
            if (!client) return;
            setVaultLockSubmitting(true);
            setVaultLockError(null);
            void (async () => {
              try {
                if (target.method === "dpapi") {
                  await client.unlockVault({ windowsPassword: value });
                } else {
                  await client.unlockVault({ pin: value });
                }
                setVaultLockPrompt(null);
                await attemptLockToVault(target.paths);
              } catch {
                setVaultLockError(target.method === "dpapi" ? "Wrong Windows password." : "Wrong PIN.");
              } finally {
                setVaultLockSubmitting(false);
              }
            })();
          }}
          onCancel={() => {
            setVaultLockPrompt(null);
            setVaultLockError(null);
          }}
        />
      )}

      {vaultRestoreRequest && (
        <CredentialPrompt
          method={vaultRestoreRequest.method}
          title={`Restore "${vaultRestoreRequest.filename}"`}
          detail="Decrypts it and puts it in the folder you dropped it on, no longer hidden. Always re-checks your credential fresh, even though Your Eyes Only may already be unlocked for browsing."
          confirmLabel="Restore"
          submitting={vaultRestoreSubmitting}
          error={vaultRestoreError}
          onSubmit={(value) => {
            const target = vaultRestoreRequest;
            const client = clientRef.current;
            if (!client || !currentDir) return;
            setVaultRestoreSubmitting(true);
            setVaultRestoreError(null);
            void (async () => {
              try {
                const creds = target.method === "dpapi" ? { windowsPassword: value } : { pin: value };
                await client.restoreVaultFile({
                  rootPath: target.root ?? currentDir,
                  entryId: target.entryId,
                  destDir: target.destDir,
                  ...creds,
                });
                setVaultRestoreRequest(null);
                await refreshAfterMutation();
              } catch {
                setVaultRestoreError(target.method === "dpapi" ? "Wrong Windows password." : "Wrong PIN.");
              } finally {
                setVaultRestoreSubmitting(false);
              }
            })();
          }}
          onCancel={() => {
            setVaultRestoreRequest(null);
            setVaultRestoreError(null);
          }}
        />
      )}

      {quickLookItem && (
        <QuickLookOverlay
          item={quickLookItem}
          client={client}
          onClose={() => setQuickLookItem(null)}
          onOpenFile={handleOpenFile}
          pdfPage={quickLookPdfPage}
          onPdfPageChange={setQuickLookPdfPage}
          onPdfPageCount={setQuickLookPdfPageCount}
        />
      )}
      </div>
    </div>
  );
}

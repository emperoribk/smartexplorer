import type { DirEntry, SearchResult, TimelineItem } from "./types";

export type ItemKind = "directory" | "image" | "video" | "pdf" | "installer" | "text" | "other";

export interface GridItem {
  path: string;
  name: string;
  isDirectory: boolean;
  kind: ItemKind;
  matchType?: "name" | "content" | "visual";
  score?: number;
  size?: number;
  mtimeMs?: number;
  /** Which indexed folder a result came from, set only in "search all
   *  folders" mode (where results can span many locations and the plain
   *  grid needs to say where each one lives) - the folder's own name, e.g.
   *  "Downloads", not the full path (that's still in the hover tooltip). */
  folderLabel?: string;
  /** The full path of the indexed root this item belongs to (as opposed to
   *  folderLabel's display-only basename) - only set for search results,
   *  which can span folders other than the one currently open. Needed for
   *  anything that has to find that folder's own index.db, like Smart
   *  auto-naming's /suggest-name call. A plain browse-mode item has no
   *  `root` here; callers fall back to whatever folder is currently open. */
  root?: string;
}

/** Cross-platform basename for a root path - Windows paths still show up
 *  with backslashes here even off-Windows, since this is display text, not
 *  something passed back to the filesystem. */
function folderLabel(rootPath: string): string {
  const segments = rootPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? rootPath;
}

export function fromDirEntry(entry: DirEntry): GridItem {
  let kind: ItemKind = "other";
  if (entry.isDirectory) kind = "directory";
  else if (entry.isVideo) kind = "video";
  else if (entry.isImage) kind = "image";
  else if (entry.isPdf) kind = "pdf";
  else if (entry.isInstaller) kind = "installer";
  else if (entry.isDocument) kind = "text";
  return {
    path: entry.path,
    name: entry.name,
    isDirectory: entry.isDirectory,
    kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  };
}

/** The backend only knows "text" | "image" | "video" | "other" for search
 *  hits, so PDFs get sniffed from the filename here too - otherwise a PDF
 *  found by search would lose its distinct icon that browsing shows. */
export function fromSearchResult(result: SearchResult): GridItem {
  const ext = result.filename.slice(result.filename.lastIndexOf(".")).toLowerCase();
  let kind: ItemKind = result.kind === "text" ? "text" : (result.kind as ItemKind);
  if (ext === ".pdf") kind = "pdf";
  return {
    path: result.path,
    name: result.filename,
    isDirectory: false,
    kind,
    matchType: result.match_type,
    score: result.score,
    folderLabel: result.root ? folderLabel(result.root) : undefined,
    root: result.root,
  };
}

/** Settings > "Show file extensions". Off by default (names read cleaner
 *  without them); App.tsx keeps this in sync with the saved preference and
 *  re-renders when it changes. */
let showExtensions = false;
export function setShowExtensions(value: boolean): void {
  showExtensions = value;
}

/** Strips the extension for display only - the full name (with extension)
 *  is still used for opening, sorting, and the hover tooltip, so nothing
 *  about how the file is identified changes, just how it reads in the grid. */
export function displayName(item: GridItem): string {
  if (item.isDirectory || showExtensions) return item.name;
  const idx = item.name.lastIndexOf(".");
  if (idx <= 0) return item.name;
  return item.name.slice(0, idx);
}

/** Buckets items into the familiar "Today / Yesterday / This week / Earlier"
 *  groups Windows/macOS file explorers use, sorted newest-first within each
 *  group. Only meaningful for browse mode - search results are ranked by
 *  relevance instead, not grouped by date. */
export function groupByDate(items: GridItem[]): { label: string; items: GridItem[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400_000;
  const startOfWeek = startOfToday - 7 * 86400_000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();

  const buckets: Record<string, GridItem[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    "This month": [],
    "This year": [],
    Older: [],
  };

  // Directories first (conventional explorer behavior), each group sorted
  // by name; files bucketed by modified time and sorted newest-first.
  const dirs: GridItem[] = [];
  const files: GridItem[] = [];
  for (const item of items) {
    (item.isDirectory ? dirs : files).push(item);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of files) {
    const t = item.mtimeMs ?? 0;
    if (t >= startOfToday) buckets["Today"].push(item);
    else if (t >= startOfYesterday) buckets["Yesterday"].push(item);
    else if (t >= startOfWeek) buckets["This week"].push(item);
    else if (t >= startOfMonth) buckets["This month"].push(item);
    else if (t >= startOfYear) buckets["This year"].push(item);
    else buckets["Older"].push(item);
  }
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }

  const groups: { label: string; items: GridItem[] }[] = [];
  if (dirs.length > 0) groups.push({ label: "Folders", items: dirs });
  for (const label of ["Today", "Yesterday", "This week", "This month", "This year", "Older"]) {
    if (buckets[label].length > 0) groups.push({ label, items: buckets[label] });
  }
  return groups;
}

/** One row of the /timeline response -> a grid tile. Same pdf-sniffing as
 *  fromSearchResult; mtime arrives in seconds, tiles want milliseconds. */
export function fromTimelineItem(t: TimelineItem): GridItem {
  const dot = t.filename.lastIndexOf(".");
  const ext = dot >= 0 ? t.filename.slice(dot).toLowerCase() : "";
  let kind: ItemKind = t.kind === "text" || t.kind === "image" || t.kind === "video" ? (t.kind as ItemKind) : "other";
  if (ext === ".pdf") kind = "pdf";
  const parts = t.path.replace(/\\/g, "/").split("/").filter(Boolean);
  return {
    path: t.path,
    name: t.filename,
    isDirectory: false,
    kind,
    size: t.size ?? undefined,
    mtimeMs: t.mtime * 1000,
    folderLabel: parts.length >= 2 ? parts[parts.length - 2] : folderLabel(t.root),
    root: t.root,
  };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Label for the timeline's date headings: Today / Yesterday / "Wednesday,
 *  Sep 30" for the last two weeks, then a plain "September 2026". */
export function timelineLabel(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startToday - startDay) / 86400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 14) return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Groups an already newest-first list into consecutive date sections.
 *  Deliberately does NOT re-sort - the server's keyset order is the truth,
 *  and appended pages simply extend the last group or start new ones. */
export function groupByTimeline(items: GridItem[], now: Date = new Date()): { label: string; items: GridItem[] }[] {
  const groups: { label: string; items: GridItem[] }[] = [];
  for (const item of items) {
    const label = timelineLabel(item.mtimeMs ?? 0, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** "1.1 MB" style size, same granularity the status bar uses. */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "";
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

/** Short type label for the small caption under a tile: "PNG", "PDF",
 *  "Folder" - the upper-cased extension when there is one. */
export function fileTypeLabel(item: GridItem): string {
  if (item.isDirectory) return "Folder";
  const dot = item.name.lastIndexOf(".");
  if (dot > 0 && dot < item.name.length - 1) return item.name.slice(dot + 1).toUpperCase().slice(0, 5);
  return item.kind === "video" ? "Video" : item.kind === "image" ? "Image" : "File";
}

export type SortKey = "date" | "name" | "size";
export type GroupMode = "date" | "none";

/** Sections for the browse grid, honouring the toolbar's Sort and Group by
 *  choices. Folders always come first, sorted by name, like File Explorer. */
export function buildGroups(
  items: GridItem[],
  sortKey: SortKey,
  groupMode: GroupMode
): { label: string; items: GridItem[] }[] {
  const compare = (a: GridItem, b: GridItem): number => {
    if (sortKey === "name") return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    if (sortKey === "size") return (b.size ?? 0) - (a.size ?? 0);
    return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
  };
  if (groupMode === "date") {
    const groups = groupByDate(items);
    if (sortKey !== "date") {
      for (const g of groups) {
        if (g.label !== "Folders") g.items.sort(compare);
      }
    }
    return groups;
  }
  const dirs = items.filter((i) => i.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  const files = items.filter((i) => !i.isDirectory).sort(compare);
  const groups: { label: string; items: GridItem[] }[] = [];
  if (dirs.length > 0) groups.push({ label: "Folders", items: dirs });
  if (files.length > 0) groups.push({ label: dirs.length > 0 ? "Files" : "", items: files });
  return groups;
}

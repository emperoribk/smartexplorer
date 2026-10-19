import type {
  SmartSearchApi,
  DirEntry,
  SpecialFolders,
  DiskUsage,
  RecycleBinEntry,
  RecycleBinListing,
  RecycleBinActionResult,
} from "../preload/preload";

export type { DirEntry, SpecialFolders, DiskUsage, RecycleBinEntry, RecycleBinListing, RecycleBinActionResult };

declare global {
  interface Window {
    smartsearch: SmartSearchApi;
  }
}

export interface SearchResult {
  path: string;
  filename: string;
  kind: "text" | "image" | "video" | "other";
  score: number;
  match_type: "name" | "content" | "visual";
  root: string;
}

/** What the natural-language query parser (query_parse.py, backend)
 *  understood from a loosely-phrased search, e.g. "that ticket screenshot
 *  from last week" - the real content words it searched for once filler was
 *  stripped, and short labels for any kind/date filter it inferred from the
 *  phrasing. Shown back in the results banner so narrowing is never a
 *  silent, unexplained thing. */
export interface SearchQueryInfo {
  content_query: string;
  filter_labels: string[];
}

export interface SearchResponse {
  results: SearchResult[];
  query_info: SearchQueryInfo;
}

/** Response shape for "Find similar" (/similar) - a right-click action on
 *  one file, not a typed query, so there's no query_info to show (nothing
 *  was parsed from typed text). Deliberately the same SearchResult[] shape
 *  as SearchResponse so the renderer can reuse fromSearchResult/FileGrid
 *  as-is - see gridItem.ts. */
export interface SimilarResponse {
  results: SearchResult[];
}

export interface HealthResponse {
  ok: boolean;
  /** Whether Tesseract OCR is actually installed and working, so "text
   *  inside a photo/screenshot" search has anything to find. Tesseract is a
   *  separate native install, not something that comes bundled, so this can
   *  be false on an otherwise fully-working install. */
  ocr_available: boolean;
}

/** Background indexing of the main folders (Documents, Pictures, ...) -
 *  the backend's autoindex.py. */
export interface AutoIndexRootProgress {
  root: string;
  status: "queued" | "idle" | "indexing" | "done" | "error";
  processed: number;
  total: number;
}

export interface AutoIndexStatus {
  enabled: boolean;
  state: "idle" | "indexing" | "waiting_model" | "paused";
  current_root: string;
  roots: AutoIndexRootProgress[];
  overall_total: number;
  overall_processed: number;
  first_pass_done: boolean;
  /** Epoch seconds of the last finished sweep, or null. */
  last_finished: number | null;
  error: string | null;
}

export interface IndexStatusResponse {
  root: string;
  status: "idle" | "indexing" | "done" | "error";
  total: number;
  processed: number;
  current_file: string;
  error: string | null;
}

/** One immediate child of the folder currently on screen in the storage
 *  chart (see diskusage.py) - a file's own byte size, or a folder's
 *  full recursive total. `path` is absolute, ready to hand straight back
 *  to /disk-usage/start to drill into it. */
export interface DiskUsageEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** Status of one folder's disk-usage scan (/disk-usage/start,
 *  /disk-usage/status) - polled the same way IndexStatusResponse is
 *  (see App.tsx's waitForIndexDone). `entries` is only populated once
 *  `status` is "done"; `inaccessible` counts children the scan couldn't
 *  read (permission-denied system folders, etc.) rather than silently
 *  leaving them out with no explanation. */
export interface DiskUsageScanStatus {
  root: string;
  status: "idle" | "scanning" | "done" | "error";
  error: string | null;
  inaccessible: number;
  entries: DiskUsageEntry[];
}

/** Plain-text extraction for Quick Look's preview of a file that isn't an
 *  image/video/PDF (see QuickLookOverlay.tsx) - backed by the exact same
 *  extract.py logic that already makes these files' contents searchable.
 *  An empty `text` on a non-empty file means extract_text didn't know how
 *  to read that format (e.g. .xlsx/.pptx) rather than the file truly being
 *  blank - the frontend treats that as "no preview available". */
export interface PreviewTextResponse {
  text: string;
  truncated: boolean;
  /** Pictures inside a .docx as data: URLs (often the whole content of a
   *  scanned/screenshotted page saved as Word). Only set for .docx. */
  images?: string[];
  images_truncated?: boolean;
}

/** A group of files that are byte-for-byte identical (same content hash) -
 *  any kind, not just images (two copies of an installer, a doc saved
 *  twice, etc). See duplicates.py. */
export interface ExactDuplicateGroup {
  paths: string[];
  filenames: string[];
  size: number;
  kind: "text" | "image" | "video" | "other";
}

/** A group of images CLIP's embedding says are near-identical, even though
 *  their bytes differ (a resave, a crop, a re-screenshot of the same
 *  moment). min/max_similarity are the loosest and tightest pairwise
 *  cosine similarity found within the group - see duplicates.py for why
 *  those can differ within one group. */
export interface NearDuplicateGroup {
  paths: string[];
  filenames: string[];
  min_similarity: number;
  max_similarity: number;
}

/** A group of documents (PDF/DOCX/TXT/MD - see duplicates.py's
 *  DOC_NEAR_DUP_EXTS) whose extracted text says they're essentially the
 *  same document, even though their bytes differ - the same letter
 *  exported as both .pdf and .docx, a renamed second copy, a lightly
 *  edited draft. Same min/max_similarity meaning as NearDuplicateGroup. */
export interface NearDuplicateDocumentGroup {
  paths: string[];
  filenames: string[];
  min_similarity: number;
  max_similarity: number;
}

export interface DuplicatesResponse {
  exact_groups: ExactDuplicateGroup[];
  near_duplicate_groups: NearDuplicateGroup[];
  near_duplicate_document_groups: NearDuplicateDocumentGroup[];
}

/** One thing sensitive.py's scan found in a single file's extracted/OCR'd
 *  text - an SSN, a credit card number, a bank routing number, a private
 *  key block. `masked` is already redacted server-side (e.g. "SSN ending
 *  1234") - the real value never crosses into the renderer. `count` is how
 *  many times that exact masked value appears in the file. */
export interface SensitiveFinding {
  kind: "ssn" | "credit_card" | "routing_number" | "private_key";
  masked: string;
  count: number;
}

/** A single file flagged by the sensitive-content scan, with everything
 *  found in it. See sensitive.py's scan_folder. */
export interface SensitiveFlaggedFile {
  path: string;
  filename: string;
  kind: "text" | "image";
  findings: SensitiveFinding[];
}

/** A file the scan found sensitive content in and *also* moved straight
 *  into "Your Eyes Only" (see vault.py) because a vault key happened to be
 *  available to lock with at scan time - the normal case once the vault is
 *  set up. `id` is the vault entry id to use with the vault/* calls below;
 *  the original file is gone from this folder the moment this appears. */
export interface NewlyVaultedFile {
  id: string;
  filename: string;
  findings: SensitiveFinding[];
}

/** `flagged_files` only ever has entries when nothing could be locked right
 *  now (most commonly: the vault hasn't been set up yet) - see main.py's
 *  /sensitive-scan. Once Your Eyes Only is set up, a scan's results land in
 *  `newly_vaulted` instead and the originals are already gone. */
export interface SensitiveScanResponse {
  flagged_files: SensitiveFlaggedFile[];
  newly_vaulted: NewlyVaultedFile[];
  vault_status: VaultStatus;
}

/** Mirrors main.py's _vault_status_summary(). `method` is null until
 *  setup has happened once; after that it's fixed ("pin" or "dpapi") for
 *  this machine. `unlocked_for_locking` means a key is available in memory
 *  right now well enough to *encrypt* a newly-flagged file - it says
 *  nothing about whether *opening* an existing vaulted file would succeed,
 *  which always re-checks fresh (see vault.py's module docstring on why
 *  those two are deliberately different strengths of "unlocked"). */
export interface VaultStatus {
  set_up: boolean;
  method: "pin" | "dpapi" | null;
  unlocked_for_locking: boolean;
  /** Whether the Windows account signed in right now has a login password
   *  - null if that couldn't be determined (e.g. not running on Windows).
   *  Drives the setup flow: a password means "Your Eyes Only" can just
   *  reuse it, no password means the person is asked to pick a PIN. */
  windows_has_password: boolean | null;
}

/** One file sitting in "Your Eyes Only" right now - see vault.py's
 *  VaultEntry / main.py's /vault/list. Never carries the file's actual
 *  bytes or any unmasked finding value, only metadata. */
export interface VaultEntry {
  id: string;
  filename: string;
  size: number;
  /** Unix seconds. */
  locked_at: number;
  reasons: string[];
  /** True when this entry is a whole locked FOLDER rather than a single
   *  file (see vault.py's lock_file/restore_file) - opening or restoring
   *  it still works the same way from the UI's side, this just changes
   *  what icon/label makes sense to show. */
  is_folder: boolean;
  /** The folder whose vault holds this entry - needed to open or restore it,
   *  since each folder keeps its own vault. Set by /vault/list-all. */
  root?: string;
  /** Where it was locked from. */
  original_path?: string;
}

export interface VaultListResponse {
  entries: VaultEntry[];
}

/** Returned by /vault/open: a plaintext copy written to a temp folder,
 *  openable with the file's normal default app - looks and behaves like a
 *  completely ordinary PDF/Word/text file once decrypted, exactly as
 *  intended ("gibberish for a stranger, normal for you"). The temp copy is
 *  best-effort cleaned up by the Electron main process - see
 *  main/main.ts's "vault:openTemp" handler. */
export interface VaultOpenResponse {
  temp_path: string;
}

export interface VaultRestoreResponse {
  restored_path: string;
}

/** Returned by /vault/lock - the manual "send this file into Your Eyes
 *  Only" action (see main.py's post_vault_lock). Same shape as a single
 *  entry's identity, enough for the UI to confirm which file moved. */
export interface VaultLockResponse {
  id: string;
  filename: string;
}

/** `suggested` is null when there's no extracted text to draw a name from
 *  (never-indexed file, or text that came up empty) - the UI treats that as
 *  "nothing to suggest here", not an error. When it's null specifically
 *  because this looks like a scanned/photographed file that needs OCR and
 *  Tesseract isn't installed, `reason` says so ("ocr_unavailable") instead
 *  of leaving the UI to show the same generic "nothing here" message for a
 *  fixable and an unfixable case alike - see main.py's /suggest-name. */
export interface SuggestNameResponse {
  suggested: string | null;
  reason: "ocr_unavailable" | null;
}


/** What a file can be converted to, e.g. [".docx", ".txt"] for a PDF - an
 *  empty list means no "Convert to..." items belong in its context menu at
 *  all. See convert.py's supported_targets - this always reflects exactly
 *  what the backend itself will accept, so the menu never offers a
 *  conversion the backend would then refuse. */
export interface ConvertTargetsResponse {
  targets: string[];
}

/** The new file a conversion produced, written alongside the original
 *  (which is left untouched) - see convert.py. */
export interface ConvertResponse {
  path: string;
}

export interface TimelineItem {
  path: string;
  filename: string;
  kind: string;
  size: number | null;
  /** Epoch SECONDS (the index stores it that way). */
  mtime: number;
  root: string;
}

export interface TimelineResponse {
  items: TimelineItem[];
  has_more: boolean;
  next_before: number | null;
  next_before_path: string | null;
}

export interface MemorySample {
  path: string;
  filename: string;
  kind: string;
}

export interface MemoryCard {
  id: string;
  type: "stale_folder" | "on_this_day";
  title: string;
  subtitle: string;
  detail: string;
  folder: string | null;
  count: number;
  /** Epoch seconds. */
  date: number;
  sample: MemorySample[];
}

export interface MemoriesResponse {
  cards: MemoryCard[];
}

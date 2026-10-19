import type {
  ConvertResponse,
  ConvertTargetsResponse,
  DiskUsageScanStatus,
  DuplicatesResponse,
  SensitiveScanResponse,
  HealthResponse,
  AutoIndexStatus,
  IndexStatusResponse,
  MemoriesResponse,
  PreviewTextResponse,
  SearchResponse,
  SimilarResponse,
  SuggestNameResponse,
  TimelineResponse,
  VaultListResponse,
  VaultLockResponse,
  VaultOpenResponse,
  VaultRestoreResponse,
  VaultStatus,
} from "./types";

/** Thin wrapper around the local Python backend's HTTP API. */
export function backendClient(port: number) {
  const base = `http://127.0.0.1:${port}`;

  return {
    async health(): Promise<HealthResponse> {
      const res = await fetch(`${base}/health`);
      if (!res.ok) throw new Error(`health failed: ${res.status}`);
      return res.json();
    },

    async startIndex(rootPath: string): Promise<IndexStatusResponse> {
      const res = await fetch(`${base}/index/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root_path: rootPath }),
      });
      if (!res.ok) throw new Error(`index/start failed: ${res.status}`);
      return res.json();
    },

    async autoIndexStart(roots: string[]): Promise<AutoIndexStatus> {
      const res = await fetch(`${base}/autoindex/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots }),
      });
      if (!res.ok) throw new Error(`autoindex/start failed: ${res.status}`);
      return res.json();
    },

    async autoIndexStop(): Promise<AutoIndexStatus> {
      const res = await fetch(`${base}/autoindex/stop`, { method: "POST" });
      if (!res.ok) throw new Error(`autoindex/stop failed: ${res.status}`);
      return res.json();
    },

    async autoIndexStatus(): Promise<AutoIndexStatus> {
      const res = await fetch(`${base}/autoindex/status`);
      if (!res.ok) throw new Error(`autoindex/status failed: ${res.status}`);
      return res.json();
    },

    async indexStatus(rootPath: string): Promise<IndexStatusResponse> {
      const res = await fetch(`${base}/index/status?root_path=${encodeURIComponent(rootPath)}`);
      if (!res.ok) throw new Error(`index/status failed: ${res.status}`);
      return res.json();
    },

    /** Kicks off (or - the common case - just returns) `rootPath`'s
     *  disk-usage scan of its IMMEDIATE children only, for the storage
     *  chart - see diskusage.py's module docstring for why this is one
     *  level at a time rather than a whole-drive walk. A scan already
     *  running OR already finished is reused as-is (that's what makes
     *  App.tsx's startup prewarm actually save time); pass `force: true`
     *  only for an explicit "rescan" action, since this walks the whole
     *  subtree again and isn't cheap. Poll with diskUsageStatus until
     *  status is "done"/"error", same pattern as startIndex/indexStatus. */
    async startDiskUsageScan(rootPath: string, force = false): Promise<DiskUsageScanStatus> {
      const res = await fetch(`${base}/disk-usage/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root_path: rootPath, force }),
      });
      if (!res.ok) throw new Error(`disk-usage/start failed: ${res.status}`);
      return res.json();
    },

    async diskUsageStatus(rootPath: string): Promise<DiskUsageScanStatus> {
      const res = await fetch(`${base}/disk-usage/status?root_path=${encodeURIComponent(rootPath)}`);
      if (!res.ok) throw new Error(`disk-usage/status failed: ${res.status}`);
      return res.json();
    },

    /** Quick Look's text fallback (see QuickLookOverlay.tsx) for anything
     *  that isn't an image/video/PDF - a .docx, a .txt, etc. Backed by the
     *  same best-effort extraction indexing already uses; an empty `text`
     *  on a real file just means that format isn't one extract_text knows
     *  how to read, not that the file is actually blank. */
    async previewText(path: string): Promise<PreviewTextResponse> {
      const res = await fetch(`${base}/preview/text?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`preview/text failed: ${res.status}`);
      return res.json();
    },

    async search(rootPath: string, query: string): Promise<SearchResponse> {
      const res = await fetch(
        `${base}/search?root_path=${encodeURIComponent(rootPath)}&q=${encodeURIComponent(query)}`
      );
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      return res.json();
    },

    /** Searches every already-indexed folder at once and returns one merged,
     *  re-ranked list - "search everywhere", as opposed to search()'s single
     *  current folder. Folders that were never indexed are just skipped. */
    async searchAll(roots: string[], query: string): Promise<SearchResponse> {
      const res = await fetch(`${base}/search/all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots, q: query }),
      });
      if (!res.ok) throw new Error(`search/all failed: ${res.status}`);
      return res.json();
    },

    /** "Find similar" - a right-click action on one already-indexed file:
     *  everything else in this folder that's semantically/visually related
     *  to it (CLIP similarity for an image, extracted-text overlap for a
     *  document), rather than a typed query. Same SearchResult[] shape as
     *  search(), so the results view reuses the same grid. */
    async findSimilar(rootPath: string, path: string): Promise<SimilarResponse> {
      const res = await fetch(
        `${base}/similar?root_path=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(path)}`
      );
      if (!res.ok) throw new Error(`similar failed: ${res.status}`);
      return res.json();
    },

    /** Duplicate/near-duplicate files already found in this folder's index -
     *  a read of what's already there (hashes, CLIP embeddings), computed
     *  fresh on each call rather than cached, since it's cheap and the
     *  index can keep changing in the background. */
    async getDuplicates(rootPath: string): Promise<DuplicatesResponse> {
      const res = await fetch(`${base}/duplicates?root_path=${encodeURIComponent(rootPath)}`);
      if (!res.ok) throw new Error(`duplicates failed: ${res.status}`);
      return res.json();
    },

    /** Sensitive-content scan - files whose extracted/OCR'd text already
     *  sitting in this folder's index contains something like an SSN,
     *  credit card number, bank routing number, or a private key block
     *  (see sensitive.py). Read-only, same as getDuplicates; masked values
     *  only, never the real match. */
    async getSensitiveScan(rootPath: string): Promise<SensitiveScanResponse> {
      const res = await fetch(`${base}/sensitive-scan?root_path=${encodeURIComponent(rootPath)}`);
      if (!res.ok) throw new Error(`sensitive-scan failed: ${res.status}`);
      return res.json();
    },

    /** One newest-first page of every indexed file across `roots`, all
     *  types mixed (see memories.py). Page with the cursor the previous
     *  response returned (next_before / next_before_path). */
    async getTimeline(
      roots: string[],
      opts: {
        kinds?: string[];
        before?: number | null;
        beforePath?: string | null;
        limit?: number;
        /** Only these extensions (no dots). Omit to show every non-noise file. */
        exts?: string[];
      } = {}
    ): Promise<TimelineResponse> {
      const q = new URLSearchParams();
      for (const r of roots) q.append("root_path", r);
      if (opts.kinds && opts.kinds.length) q.set("kinds", opts.kinds.join(","));
      if (opts.before != null) q.set("before", String(opts.before));
      if (opts.beforePath != null) q.set("before_path", opts.beforePath);
      if (opts.limit) q.set("limit", String(opts.limit));
      if (opts.exts) q.set("exts", opts.exts.join(","));
      const res = await fetch(`${base}/timeline?${q.toString()}`);
      if (!res.ok) throw new Error(`timeline failed: ${res.status}`);
      return res.json();
    },

    /** Gentle-resurfacing cards ("nothing here has changed in 2 years",
     *  "on this day") - a handful at most; see memories.py. */
    async getMemories(roots: string[], exts?: string[]): Promise<MemoriesResponse> {
      const q = new URLSearchParams();
      for (const r of roots) q.append("root_path", r);
      if (exts) q.set("exts", exts.join(","));
      const res = await fetch(`${base}/memories?${q.toString()}`);
      if (!res.ok) throw new Error(`memories failed: ${res.status}`);
      return res.json();
    },

    /** Smart auto-naming: a filename suggestion built from the OCR/extracted
     *  text this file already has in the index - see namegen.py. No new
     *  OCR/CLIP work happens on this call, just a lookup, so it's cheap
     *  enough to fire on every "Suggest a name" click. */
    async suggestName(rootPath: string, path: string): Promise<SuggestNameResponse> {
      const res = await fetch(`${base}/suggest-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root_path: rootPath, path }),
      });
      if (!res.ok) throw new Error(`suggest-name failed: ${res.status}`);
      return res.json();
    },

    /** What this file could become - see types.ts's ConvertTargetsResponse.
     *  A plain GET since it's a pure read (no conversion happens here),
     *  cheap enough to call every time a context menu opens. */
    async convertTargets(path: string): Promise<ConvertTargetsResponse> {
      const res = await fetch(`${base}/convert/targets?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`convert/targets failed: ${res.status}`);
      return res.json();
    },

    /** Converts a file to targetExt (e.g. ".docx"), writing the result
     *  alongside the original rather than replacing it - see convert.py. */
    async convertFile(path: string, targetExt: string): Promise<ConvertResponse> {
      const res = await fetch(`${base}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, target_ext: targetExt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `convert failed: ${res.status}`);
      }
      return res.json();
    },

    /** Current state of "Your Eyes Only" (see vault.py) - set up yet or
     *  not, which method this machine uses, whether a key is available
     *  right now for locking new files, and whether the signed-in Windows
     *  account has a login password (drives which setup option the UI
     *  offers). Cheap, side-effect-free; safe to poll. */
    async getVaultStatus(): Promise<VaultStatus> {
      const res = await fetch(`${base}/vault/status`);
      if (!res.ok) throw new Error(`vault/status failed: ${res.status}`);
      return res.json();
    },

    /** First-time setup, exactly once per machine: either "pin" (a PIN the
     *  person chooses themselves, when Windows has no login password to
     *  reuse) or "dpapi" (reuse the Windows account's own password via
     *  Windows' own credential store - see vault.py's dpapi_protect). On
     *  success this also unlocks the session, same as unlockVault below. */
    async setupVault(args: { method: "pin" | "dpapi"; pin?: string; windowsPassword?: string }): Promise<VaultStatus> {
      const res = await fetch(`${base}/vault/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: args.method, pin: args.pin, windows_password: args.windowsPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `vault/setup failed: ${res.status}`);
      }
      return res.json();
    },

    /** Unlocks the *session* only - enough to browse Your Eyes Only's
     *  list (getVaultList below). Deliberately NOT enough to actually open
     *  or restore a specific file - see vault.py's module docstring and
     *  openVaultFile/restoreVaultFile below, which always re-check fresh. */
    async unlockVault(args: { pin?: string; windowsPassword?: string }): Promise<VaultStatus> {
      const res = await fetch(`${base}/vault/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: args.pin, windows_password: args.windowsPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Wrong PIN or password.`);
      }
      return res.json();
    },

    /** Re-locks the session (e.g. "Lock now" button, or leaving the vault
     *  view) - clears the cached session key so the list can't be browsed
     *  again without unlocking fresh. Doesn't touch any file. */
    async lockVaultNow(): Promise<VaultStatus> {
      const res = await fetch(`${base}/vault/lock-now`, { method: "POST" });
      if (!res.ok) throw new Error(`vault/lock-now failed: ${res.status}`);
      return res.json();
    },

    /** Everything currently sitting in Your Eyes Only for this folder.
     *  Requires the session to already be unlocked (unlockVault above) -
     *  a 401 here means "unlock first", surfaced by the caller as a prompt
     *  rather than a hard error. */
    async getVaultList(rootPath: string): Promise<VaultListResponse> {
      const res = await fetch(`${base}/vault/list?root_path=${encodeURIComponent(rootPath)}`);
      if (res.status === 401) throw new Error("unlock_required");
      if (!res.ok) throw new Error(`vault/list failed: ${res.status}`);
      return res.json();
    },

    /** Everything in Your Eyes Only from every folder that holds a vault, not
     *  just one - `extraRoots` are folders the app has seen, so vaults made
     *  before the backend kept its own list are still found. */
    async getVaultListAll(extraRoots: string[]): Promise<VaultListResponse> {
      const qs = extraRoots.map((r) => `extra_roots=${encodeURIComponent(r)}`).join("&");
      const res = await fetch(`${base}/vault/list-all${qs ? `?${qs}` : ""}`);
      if (res.status === 401) throw new Error("unlock_required");
      if (!res.ok) throw new Error(`vault/list-all failed: ${res.status}`);
      return res.json();
    },

    /** Decrypts one vaulted file to a temp copy that opens with its
     *  normal default app - always re-checks the PIN/password fresh,
     *  regardless of whether the session is already unlocked (see
     *  vault.py: this is the step that has to stop someone merely sitting
     *  at an already-unlocked laptop). A wrong credential throws, surfaced
     *  by the caller as "wrong PIN/password" rather than a generic error. */
    async openVaultFile(args: { rootPath: string; entryId: string; pin?: string; windowsPassword?: string }): Promise<VaultOpenResponse> {
      const res = await fetch(`${base}/vault/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root_path: args.rootPath,
          entry_id: args.entryId,
          pin: args.pin,
          windows_password: args.windowsPassword,
        }),
      });
      if (res.status === 401) throw new Error("wrong_credential");
      if (!res.ok) throw new Error(`vault/open failed: ${res.status}`);
      return res.json();
    },

    /** Decrypts a vaulted file and writes it back to disk - "I'm done
     *  being careful with this one, put it back." Same fresh-credential
     *  check as open. Defaults to the file's original folder (with a "-2"
     *  style suffix if something new already took that name - see
     *  main.py's _next_available_stem); pass destDir (a folder the entry
     *  was drag-and-dropped onto - a Sidebar row, a Breadcrumb segment, a
     *  FileGrid directory tile) to restore there instead, under the
     *  file's original name. */
    async restoreVaultFile(args: {
      rootPath: string;
      entryId: string;
      pin?: string;
      windowsPassword?: string;
      destDir?: string;
    }): Promise<VaultRestoreResponse> {
      const res = await fetch(`${base}/vault/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root_path: args.rootPath,
          entry_id: args.entryId,
          pin: args.pin,
          windows_password: args.windowsPassword,
          dest_dir: args.destDir,
        }),
      });
      if (res.status === 401) throw new Error("wrong_credential");
      if (!res.ok) throw new Error(`vault/restore failed: ${res.status}`);
      return res.json();
    },

    /** Manually sends ONE file straight into Your Eyes Only, no detected
     *  sensitive content required - a person's own "hide this" choice from
     *  the file browser's context menu. Deliberately the LOOSE side of the
     *  asymmetry (see main.py's post_vault_lock): needs a key that's
     *  already available this session, never a freshly-retyped PIN -
     *  that's reserved for getting a file back OUT (restoreVaultFile).
     *  Two distinct failure modes the caller needs to tell apart:
     *    "not_set_up"      - Your Eyes Only has never been set up at all
     *    "unlock_required" - it's set up, but no key is available this
     *                         session (e.g. a PIN vault nobody's unlocked
     *                         yet, or dpapi but it's been locked-now'd) */
    async lockVaultFile(args: { rootPath: string; path: string }): Promise<VaultLockResponse> {
      const res = await fetch(`${base}/vault/lock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root_path: args.rootPath, path: args.path }),
      });
      if (res.status === 401) throw new Error("unlock_required");
      if (res.status === 400) {
        const body = await res.json().catch(() => null);
        if (body?.detail === "Set up Your Eyes Only first.") throw new Error("not_set_up");
        throw new Error(body?.detail ?? `vault/lock failed: ${res.status}`);
      }
      if (!res.ok) throw new Error(`vault/lock failed: ${res.status}`);
      return res.json();
    },
  };
}

export type BackendClient = ReturnType<typeof backendClient>;

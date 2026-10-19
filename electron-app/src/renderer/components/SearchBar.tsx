import React, { useEffect, useRef } from "react";
import type { IndexStatusResponse } from "../types";
import { IconArrowRight, IconSearch, IconX } from "./Icons";

export function SearchBar({
  query,
  onQueryChange,
  onSubmit,
  onClear,
  indexStatus,
  searching,
  folderLabel,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onSubmit: () => void;
  /** Clears the search - and, if a search has actually run, takes the
   *  person back to browsing the folder they searched from, rather than
   *  just emptying the box and leaving stale results on screen. */
  onClear: () => void;
  indexStatus: IndexStatusResponse | null;
  searching: boolean;
  /** Current folder's display name, e.g. "Downloads" - used to make the
   *  placeholder read like a real file explorer's ("Search Downloads")
   *  instead of a long explanation of everything search can do. */
  folderLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl+K (Cmd+K on a Mac) jumps straight to the search box from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="search-bar">
      <div className="search-input-wrap">
        <IconSearch size={16} className="search-input-icon" />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder={folderLabel ? `Search ${folderLabel}` : "Search"}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          disabled={searching}
        />
        {query && !searching ? (
          <button className="search-clear-x" onClick={onClear} aria-label="Clear search">
            <IconX size={14} />
          </button>
        ) : (
          !query && (
            <span className="search-kbd" aria-hidden>
              Ctrl K
            </span>
          )
        )}
      </div>
      <button
        className="search-submit"
        onClick={onSubmit}
        disabled={searching}
        aria-label={searching ? "Searching" : "Search"}
        title={searching ? "Searching…" : "Search (Enter)"}
      >
        {searching ? <span className="search-submit-spinner" /> : <IconArrowRight size={14} />}
      </button>
      {/* No manual index/re-index control - indexing (and keeping it fresh)
       *  happens automatically and silently; see runSearch and
       *  refreshAfterMutation in App.tsx. This stays as the one thing worth
       *  surfacing without a button to press - a rare failure someone
       *  should know about, not something to act on here. */}
      {indexStatus?.status === "error" && (
        <span className="index-error" title={indexStatus.error ?? ""}>
          Indexing hit an error
        </span>
      )}
    </div>
  );
}

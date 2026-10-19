import { isVaultTempPath } from "../vaultTemp";
import React, { useEffect, useRef, useState } from "react";
import type { GridItem } from "../gridItem";
import { displayName, fileTypeLabel, formatBytes } from "../gridItem";
import type { SuggestNameResponse } from "../types";
import { TESSERACT_INSTALL_URL } from "../constants";
import { ItemThumb } from "./FileGrid";
import { IconExternal, IconFolder, IconRename, IconSparkle, IconTrash, IconX } from "./Icons";

type Suggestion =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; name: string }
  | { state: "none"; reason: "empty" | "ocr_unavailable" };

function parentOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "") || path;
}

function lastSegments(path: string, n: number): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-n).join(" / ");
}

/** The panel on the right of the file grid: a larger preview of whatever is
 *  selected, its basic facts, the smart-name suggestion, and the common
 *  actions. Hidden entirely from the toolbar's "Details" toggle. */
export function DetailsPane({
  selected,
  onOpenFile,
  onOpenDirectory,
  onStartRename,
  onRenameCommit,
  onSuggestName,
  onDelete,
  onClose,
}: {
  selected: GridItem[];
  onOpenFile: (path: string) => void;
  onOpenDirectory: (path: string) => void;
  onStartRename: (item: GridItem) => void;
  onRenameCommit: (item: GridItem, newName: string) => void;
  onSuggestName: (item: GridItem) => Promise<SuggestNameResponse>;
  onDelete: (items: GridItem[]) => void;
  onClose: () => void;
}) {
  const item = selected.length === 1 ? selected[0] : null;
  const [suggestion, setSuggestion] = useState<Suggestion>({ state: "idle" });
  const requestId = useRef(0);

  // A suggestion belongs to one file - forget it as soon as the selection moves.
  useEffect(() => {
    requestId.current += 1;
    setSuggestion({ state: "idle" });
  }, [item?.path]);

  const suggest = async (target: GridItem) => {
    const mine = ++requestId.current;
    setSuggestion({ state: "loading" });
    const result = await onSuggestName(target);
    if (mine !== requestId.current) return; // the selection changed meanwhile
    if (result.suggested) setSuggestion({ state: "ready", name: result.suggested });
    else setSuggestion({ state: "none", reason: result.reason === "ocr_unavailable" ? "ocr_unavailable" : "empty" });
  };

  const header = (
    <div className="details-head">
      <span className="details-head-title">Details</span>
      <button type="button" className="details-close" onClick={onClose} title="Hide details" aria-label="Hide details">
        <IconX size={14} />
      </button>
    </div>
  );

  if (selected.length === 0) {
    return (
      <aside className="details-pane" aria-label="Details">
        {header}
        <div className="details-empty">
          <IconFolder size={28} />
          <p>Select a file to see its details here.</p>
        </div>
      </aside>
    );
  }

  if (!item) {
    const withSizes = selected.every((i) => i.size !== undefined);
    const total = withSizes ? selected.reduce((sum, i) => sum + (i.size ?? 0), 0) : undefined;
    return (
      <aside className="details-pane" aria-label="Details">
        {header}
        <div className="details-multi">
          <b>{selected.length} items selected</b>
          {total !== undefined && <span>{formatBytes(total)} in total</span>}
        </div>
        <button type="button" className="details-danger" onClick={() => onDelete(selected)}>
          <IconTrash size={16} />
          Move to Recycle Bin
        </button>
      </aside>
    );
  }

  const when = item.mtimeMs ? new Date(item.mtimeMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

  return (
    <aside className="details-pane" aria-label="Details">
      {header}
      <div className="details-preview" key={item.path}>
        <ItemThumb item={item} />
      </div>
      <div>
        <h3 className="details-name" title={isVaultTempPath(item.path) ? item.name : item.path}>
          {item.name}
        </h3>
        <div className="details-sub">{item.isDirectory ? "Folder" : fileTypeLabel(item)}</div>
      </div>

      {!item.isDirectory && (
        <div className="details-smart">
          <div className="details-smart-head">
            <IconSparkle size={14} />
            Smart name
          </div>
          {suggestion.state === "idle" && (
            <>
              <p className="details-smart-hint">Build a clear name from what is written inside this file.</p>
              <button type="button" className="details-btn details-btn-primary" onClick={() => void suggest(item)}>
                Suggest a name
              </button>
            </>
          )}
          {suggestion.state === "loading" && <p className="details-smart-hint">Reading the file…</p>}
          {suggestion.state === "ready" && (
            <>
              <p className="details-smart-name">{suggestion.name}</p>
              <div className="details-smart-actions">
                <button
                  type="button"
                  className="details-btn details-btn-primary"
                  onClick={() => {
                    onRenameCommit(item, suggestion.name);
                  }}
                >
                  Use this name
                </button>
                <button type="button" className="details-btn details-btn-ghost" onClick={() => setSuggestion({ state: "idle" })}>
                  Dismiss
                </button>
              </div>
            </>
          )}
          {suggestion.state === "none" && (
            <>
              <p className="details-smart-hint">
                {suggestion.reason === "ocr_unavailable"
                  ? "This looks like a scanned photo. Install Tesseract OCR so its text can be read."
                  : `There is no readable text in “${displayName(item)}” to build a name from.`}
              </p>
              <div className="details-smart-actions">
                {suggestion.reason === "ocr_unavailable" && (
                  <button
                    type="button"
                    className="details-btn details-btn-primary"
                    onClick={() => window.smartsearch.openExternal(TESSERACT_INSTALL_URL)}
                  >
                    Install Tesseract
                  </button>
                )}
                <button type="button" className="details-btn details-btn-ghost" onClick={() => setSuggestion({ state: "idle" })}>
                  OK
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <dl className="details-rows">
        {!item.isDirectory && item.size !== undefined && (
          <>
            <dt>Size</dt>
            <dd>{formatBytes(item.size)}</dd>
          </>
        )}
        {when && (
          <>
            <dt>Modified</dt>
            <dd>{when}</dd>
          </>
        )}
        <dt>Location</dt>
        {isVaultTempPath(item.path) ? (
          <dd>Your Eyes Only</dd>
        ) : (
          <dd title={parentOf(item.path)}>{lastSegments(parentOf(item.path), 2)}</dd>
        )}
      </dl>

      <div className="details-actions">
        <button
          type="button"
          className="details-btn details-btn-outline"
          onClick={() => (item.isDirectory ? onOpenDirectory(item.path) : onOpenFile(item.path))}
        >
          <IconExternal size={14} />
          Open
        </button>
        <button type="button" className="details-btn details-btn-outline" onClick={() => onStartRename(item)}>
          <IconRename size={14} />
          Rename
        </button>
      </div>

      <button type="button" className="details-danger" onClick={() => onDelete([item])}>
        <IconTrash size={16} />
        Move to Recycle Bin
      </button>
    </aside>
  );
}

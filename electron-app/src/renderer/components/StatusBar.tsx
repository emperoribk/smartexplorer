import { isVaultTempPath } from "../vaultTemp";
import React from "react";
import type { GridItem } from "../gridItem";

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function StatusBar({
  itemCount,
  selected,
}: {
  itemCount: number;
  /** Zero, one, or many selected items - Ctrl/Shift-click or Ctrl/Shift+Arrow
   *  can grow this past one, same as a real file explorer's status bar
   *  switching from "name + size" to "N items selected" once more than one
   *  tile is highlighted. */
  selected: GridItem[];
}) {
  // Only bother summing sizes for a multi-selection when every item in it
  // actually has one (folders don't carry a size here) - a partial/misleading
  // total is worse than none.
  const totalSize =
    selected.length > 1 && selected.every((i) => i.size !== undefined)
      ? selected.reduce((sum, i) => sum + (i.size ?? 0), 0)
      : undefined;

  return (
    <div className="status-bar">
      <span>
        {itemCount} item{itemCount === 1 ? "" : "s"}
      </span>
      {selected.length === 1 && (
        <>
          <span className="status-bar-sep">•</span>
          <span className="status-bar-selected" title={isVaultTempPath(selected[0].path) ? selected[0].name : selected[0].path}>
            {selected[0].name}
          </span>
          {selected[0].size !== undefined && (
            <span className="status-bar-size">{formatSize(selected[0].size)}</span>
          )}
        </>
      )}
      {selected.length > 1 && (
        <>
          <span className="status-bar-sep">•</span>
          <span className="status-bar-selected">{selected.length} items selected</span>
          {totalSize !== undefined && <span className="status-bar-size">{formatSize(totalSize)}</span>}
        </>
      )}
    </div>
  );
}

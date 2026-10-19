/**
 * Shared constants/helpers for this app's in-window drag-and-drop - a file
 * tile dragged to a folder (FileGrid's own directory tiles, a Sidebar
 * entry, a Breadcrumb segment) to move it there, or a "Your Eyes Only"
 * vault row dragged to one of those same targets to restore it there. Two
 * distinct custom MIME types (never a real OS file drag, which carries a
 * "Files" type instead) so a single onDrop can tell which kind landed and
 * act accordingly, without the two drag sources needing to agree on a
 * single payload shape.
 */
import type React from "react";

export const MOVE_PATHS_MIME = "application/x-smartexplorer-move-paths";
export const VAULT_ENTRY_MIME = "application/x-smartexplorer-vault-entry";

export interface VaultEntryDragPayload {
  entryId: string;
  filename: string;
  /** The folder whose vault holds the entry (see VaultEntry.root). */
  root?: string;
}

export type DropPayload =
  | { kind: "move"; paths: string[] }
  | { kind: "vault"; entry: VaultEntryDragPayload };

/** True if this dragover carries either of the two types above - the only
 *  thing a drop target needs to know to decide whether to preventDefault()
 *  and show itself as an active drop zone. */
export function hasInternalDragPayload(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(MOVE_PATHS_MIME) || e.dataTransfer.types.includes(VAULT_ENTRY_MIME);
}

/** Reads whichever of the two payload types is actually present on a drop.
 *  null if neither parses (malformed, or genuinely an OS file drag that
 *  slipped past hasInternalDragPayload - shouldn't happen since a drop
 *  target only calls this after that check passed, but never assume). */
export function readDropPayload(e: React.DragEvent): DropPayload | null {
  const moveRaw = e.dataTransfer.getData(MOVE_PATHS_MIME);
  if (moveRaw) {
    try {
      const paths = JSON.parse(moveRaw);
      if (Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === "string")) {
        return { kind: "move", paths };
      }
    } catch {
      // fall through
    }
  }
  const vaultRaw = e.dataTransfer.getData(VAULT_ENTRY_MIME);
  if (vaultRaw) {
    try {
      const entry = JSON.parse(vaultRaw);
      if (entry && typeof entry.entryId === "string" && typeof entry.filename === "string") {
        return { kind: "vault", entry };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

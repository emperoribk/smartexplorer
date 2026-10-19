/**
 * IPC for the Recycle Bin screen. The renderer only ever sends opaque entry
 * ids (see recycleBin.ts) - never file paths - and the actions that destroy
 * data are exactly two: delete the listed ids, or empty the bin.
 */
import { ipcMain } from "electron";
import {
  listRecycleBin,
  restoreFromRecycleBin,
  deleteFromRecycleBin,
  emptyRecycleBin,
} from "./recycleBin";

export function registerRecycleHandlers(): void {
  ipcMain.handle("recycle:list", () => listRecycleBin());
  ipcMain.handle("recycle:restore", (_event, ids: unknown) => restoreFromRecycleBin(ids));
  ipcMain.handle("recycle:delete", (_event, ids: unknown) => deleteFromRecycleBin(ids));
  ipcMain.handle("recycle:empty", () => emptyRecycleBin());
}

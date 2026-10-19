/** Shared across App.tsx (the OCR status banner) and FileGrid.tsx (the
 *  "Suggest a name" hint when a scanned file needs OCR that isn't
 *  installed) - kept in one place so the two don't drift if it's ever
 *  updated. */
export const TESSERACT_INSTALL_URL = "https://github.com/UB-Mannheim/tesseract/wiki";

/** The file types the normal folder view shows when "Show all files" is
 *  off: photos, videos, PDFs, documents and .zip. The Timeline and Memories
 *  send this to the backend so they hide exactly the same files.
 *
 *  KEEP IN SYNC with ALLOWED_EXTS (minus installers, which the Timeline
 *  leaves out on purpose) in src/main/fsBridge.ts - the main process can't
 *  import from the renderer bundle, so the list exists in both places. */
export const DEFAULT_VISIBLE_EXTS: string[] = [
  // video
  "mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv", "flv", "mpg", "mpeg",
  // images
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "svg", "heic", "heif", "ico",
  // pdf + documents
  "pdf", "doc", "docx", "rtf", "odt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "txt", "md",
  // archives
  "zip",
];

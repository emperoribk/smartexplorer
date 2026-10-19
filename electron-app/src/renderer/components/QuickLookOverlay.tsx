import React, { useEffect, useRef, useState } from "react";
import type { BackendClient } from "../api";
import type { GridItem } from "../gridItem";
import { toFileUrl } from "../fileUrl";
import { openPdfPreview, type PdfPreviewHandle } from "../pdfThumbnail";
import { IconChevron, IconFile, IconWarning, IconX } from "./Icons";

function formatSize(bytes: number): string {
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

// Within GridItem's broad "text" bucket (see gridItem.ts's fromDirEntry -
// it covers everything from .txt to .xlsx), only these are actually safe
// to read and show as plain text directly.
const PLAIN_TEXT_EXTS = new Set([".txt", ".md", ".csv", ".log", ".json", ".xml", ".yaml", ".yml", ".ini"]);
// The one binary-ish "text"-bucket format the backend's extract_text
// actually knows how to pull readable words out of (see extract.py) - an
// .xlsx/.pptx/.rtf/.odt still falls through to the plain "no preview"
// fallback below, same as it does for search indexing.
const DOCX_EXT = ".docx";
// Mirrors the backend's extract.py MAX_CHARS - the .docx path already goes
// through that bound (with a "truncated" notice), but a direct-read plain
// text file (.txt/.log/.json/...) previously had no cap at all: opening a
// gigabytes-sized log file in Quick Look would fetch the whole thing into
// memory and dump it whole into a <pre>, with real potential to hang the
// renderer. The Range header below caps the FETCH itself (not just what's
// displayed after the fact) - MAX_TEXT_FETCH_BYTES is deliberately a 4x
// margin over MAX_TEXT_CHARS since a UTF-8 character can take up to 4
// bytes, so the truncation-by-character-count below still has enough
// decoded text to work with even for a file that's all multi-byte
// characters.
const MAX_TEXT_CHARS = 200_000;
const MAX_TEXT_FETCH_BYTES = MAX_TEXT_CHARS * 4;

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx <= 0 ? "" : path.slice(idx).toLowerCase();
}

type Body =
  | { kind: "image" }
  | { kind: "video" }
  | { kind: "pdf" }
  | { kind: "text" }
  | { kind: "unsupported" };

function bodyFor(item: GridItem): Body {
  if (item.kind === "image") return { kind: "image" };
  if (item.kind === "video") return { kind: "video" };
  if (item.kind === "pdf") return { kind: "pdf" };
  if (item.kind === "text") {
    const ext = extOf(item.path);
    if (PLAIN_TEXT_EXTS.has(ext) || ext === DOCX_EXT) return { kind: "text" };
  }
  return { kind: "unsupported" };
}

function PdfBody({
  item,
  page,
  onPageChange,
  onPageCount,
}: {
  item: GridItem;
  // Page number and total-page-count are owned by App.tsx, not this
  // component, so its keydown handler can tell "turn this PDF's page"
  // apart from "switch to a different file" for the same ArrowLeft/Right
  // keys - see the state comment next to quickLookPdfPage there. This
  // also means a bad page no longer has to be "remembered" here: App.tsx
  // already resets page back to 1 whenever `item` itself changes.
  page: number;
  onPageChange: (page: number) => void;
  onPageCount: (count: number | null) => void;
}) {
  const [handle, setHandle] = useState<PdfPreviewHandle | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setHandle(null);
    setImage(null);
    setFailed(false);
    onPageCount(null);
    void openPdfPreview(item.path).then((h) => {
      if (cancelled) {
        h?.destroy();
        return;
      }
      if (!h) {
        setFailed(true);
        return;
      }
      setHandle(h);
      onPageCount(h.numPages);
    });
    return () => {
      cancelled = true;
    };
    // onPageCount is a plain setState passed down fresh each render - not
    // meaningful to this effect's identity, only item.path is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path]);

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;
    // Reset per page attempt, not just per file: `failed` used to only
    // ever get set to true and never back to false once a page's render
    // (any page's, not just the first) failed, which permanently replaced
    // the whole document - pager included - with the "couldn't render"
    // fallback, even if most of the document had rendered fine and the
    // user just turned to one bad page. Resetting it here means turning
    // to a working page recovers normally instead of staying stuck.
    setFailed(false);
    const rect = stageRef.current?.getBoundingClientRect();
    const maxWidth = Math.max(200, (rect?.width ?? 800) - 32);
    const maxHeight = Math.max(200, (rect?.height ?? 600) - 32);
    void handle.renderPage(page, maxWidth, maxHeight).then((url) => {
      if (!cancelled) {
        if (url) setImage(url);
        else setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [handle, page]);

  useEffect(() => {
    return () => handle?.destroy();
  }, [handle]);

  if (failed) {
    return (
      <div className="quicklook-unsupported">
        <IconWarning size={28} />
        <div>Couldn't render this PDF.</div>
      </div>
    );
  }

  return (
    <div className="quicklook-pdf">
      <div className="quicklook-pdf-stage" ref={stageRef}>
        {image ? <img src={image} alt={item.name} /> : <div className="quicklook-loading">Loading…</div>}
      </div>
      {handle && handle.numPages > 1 && (
        <div className="quicklook-pdf-pager">
          <button
            type="button"
            className="quicklook-pdf-pager-btn"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            title="Previous page"
          >
            <IconChevron size={14} className="quicklook-chevron-flip" />
          </button>
          <span>
            Page {page} of {handle.numPages}
          </span>
          <button
            type="button"
            className="quicklook-pdf-pager-btn"
            disabled={page >= handle.numPages}
            onClick={() => onPageChange(Math.min(handle.numPages, page + 1))}
            title="Next page"
          >
            <IconChevron size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function TextBody({ item, client }: { item: GridItem; client: BackendClient | null }) {
  const [text, setText] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [imagesTruncated, setImagesTruncated] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const ext = extOf(item.path);
  const isDocx = ext === DOCX_EXT;

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setImages([]);
    setImagesTruncated(false);
    setFailed(false);
    if (isDocx) {
      // The one binary format worth asking the backend to pull readable
      // text out of - everything else in PLAIN_TEXT_EXTS is read straight
      // off disk through the same local ssfile:// protocol images/videos
      // already use, no backend round-trip needed.
      if (!client) {
        setFailed(true);
        return;
      }
      client
        .previewText(item.path)
        .then((res) => {
          if (cancelled) return;
          const pics = res.images ?? [];
          // A Word file with no typed text is often just a scanned or
          // screenshotted page - its picture is the content, so show that
          // rather than calling the document unreadable.
          if (!res.text && pics.length === 0) setFailed(true);
          else {
            setText(res.text ?? "");
            setTruncated(res.truncated);
            setImages(pics);
            setImagesTruncated(!!res.images_truncated);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    } else {
      fetch(toFileUrl(item.path), { headers: { Range: `bytes=0-${MAX_TEXT_FETCH_BYTES - 1}` } })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.text();
        })
        .then((t) => {
          if (cancelled) return;
          if (t.length > MAX_TEXT_CHARS) {
            setText(t.slice(0, MAX_TEXT_CHARS));
            setTruncated(true);
          } else {
            setText(t);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [item.path, isDocx, client]);

  if (failed) {
    return (
      <div className="quicklook-unsupported">
        <IconFile size={28} />
        <div>{isDocx ? "Couldn't extract text from this document." : "Couldn't read this file."}</div>
      </div>
    );
  }
  if (text === null) {
    return <div className="quicklook-loading">Loading…</div>;
  }
  const hasText = text.trim().length > 0;
  return (
    <div className="quicklook-text-wrap">
      {isDocx && (
        <div className="quicklook-text-note">
          {hasText
            ? images.length > 0
              ? "Text and pictures from the document - layout and formatting aren't reproduced here."
              : "Text extracted from the document - formatting, images, and layout aren't shown here."
            : "This document has no typed text - it's made of picture(s), such as a scan or screenshot. Showing them below."}
        </div>
      )}
      {hasText && <pre className="quicklook-text">{text}</pre>}
      {images.map((src, i) => (
        <img key={i} className="quicklook-docx-image" src={src} alt={`Picture ${i + 1} in ${item.name}`} />
      ))}
      {imagesTruncated && (
        <div className="quicklook-text-note">More pictures in this document aren't shown - press Open to see everything.</div>
      )}
      {truncated && <div className="quicklook-text-note">Preview cut off - this file is longer than shown.</div>}
    </div>
  );
}

function ImageBody({ item }: { item: GridItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.path]);
  if (failed) {
    return (
      <div className="quicklook-unsupported">
        <IconWarning size={28} />
        <div>Couldn't preview this image.</div>
      </div>
    );
  }
  return (
    <img
      className="quicklook-image"
      src={toFileUrl(item.path)}
      alt={item.name}
      onError={() => setFailed(true)}
    />
  );
}

function VideoBody({ item }: { item: GridItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.path]);
  if (failed) {
    return (
      <div className="quicklook-unsupported">
        <IconWarning size={28} />
        <div>Couldn't preview this video.</div>
      </div>
    );
  }
  return (
    <video
      className="quicklook-video"
      src={toFileUrl(item.path)}
      controls
      autoPlay
      onError={() => setFailed(true)}
    />
  );
}

/** macOS-style instant preview: select a file, hit Space, see it right
 *  away without launching its actual app. Image/video are the free case -
 *  the same `ssfile://` protocol the grid's own thumbnails already use
 *  serves them directly at full resolution, no backend round-trip. PDFs
 *  render through pdfjs (see pdfThumbnail.ts), same engine as the grid's
 *  PDF tiles, just at a size that fills the window and with page paging.
 *  Everything else "text"-shaped (.txt/.md/.csv/.docx) gets a genuine, if
 *  plain-text-only, preview - formatting-heavy binary formats this app
 *  has no way to render (.xlsx/.pptx/.rtf/.odt) fall back honestly to "no
 *  preview", same as search indexing already does for those. */
export function QuickLookOverlay({
  item,
  client,
  onClose,
  onOpenFile,
  pdfPage,
  onPdfPageChange,
  onPdfPageCount,
}: {
  item: GridItem;
  client: BackendClient | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  // Owned by App.tsx, not this component - see the comment next to
  // quickLookPdfPage there for why.
  pdfPage: number;
  onPdfPageChange: (page: number) => void;
  onPdfPageCount: (count: number | null) => void;
}) {
  const body = bodyFor(item);

  return (
    <div
      className="quicklook-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="quicklook-panel" role="dialog" aria-modal="true" aria-label={item.name}>
        <div className="quicklook-header">
          <span className="quicklook-title" title={item.path}>
            {item.name}
          </span>
          {item.size != null && <span className="quicklook-size">{formatSize(item.size)}</span>}
          <div className="quicklook-header-spacer" />
          <button
            type="button"
            className="quicklook-open-btn"
            onClick={() => {
              onOpenFile(item.path);
              onClose();
            }}
            title="Open in its default app (Enter)"
          >
            Open
          </button>
          <button type="button" className="quicklook-close-btn" onClick={onClose} title="Close (Esc)">
            <IconX size={14} />
          </button>
        </div>
        <div className="quicklook-body">
          {body.kind === "image" ? (
            <ImageBody item={item} />
          ) : body.kind === "video" ? (
            <VideoBody item={item} />
          ) : body.kind === "pdf" ? (
            <PdfBody item={item} page={pdfPage} onPageChange={onPdfPageChange} onPageCount={onPdfPageCount} />
          ) : body.kind === "text" ? (
            <TextBody item={item} client={client} />
          ) : (
            <div className="quicklook-unsupported">
              <IconFile size={40} />
              <div>No preview available for this file.</div>
              <div className="quicklook-unsupported-hint">Press Enter, or click Open, to open it normally.</div>
            </div>
          )}
        </div>
        <div className="quicklook-footer-hint">← → to browse · Esc to close</div>
      </div>
    </div>
  );
}

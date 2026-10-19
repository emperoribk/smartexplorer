import React, { useState } from "react";
import type { SensitiveScanResponse, SensitiveFinding, SensitiveFlaggedFile } from "../types";
import type { GridItem } from "../gridItem";
import { ImageTile } from "./FileGrid";
import { IconFile, IconPdf, IconOther, IconWarning } from "./Icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i).toLowerCase() : "";
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirOf(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i > 0 ? normalized.slice(0, i) : normalized;
}

/** Label + color class for one finding kind - matches sensitive.py's
 *  `kind` values exactly. Deliberately short/plain ("SSN", not "Social
 *  Security Number") since the masked text already carries the detail
 *  ("SSN ending 1234"). */
const KIND_LABELS: Record<SensitiveFinding["kind"], string> = {
  ssn: "SSN",
  credit_card: "Card",
  routing_number: "Routing #",
  private_key: "Private key",
};

function FindingBadge({ finding }: { finding: SensitiveFinding }) {
  return (
    <span className={`sensitive-badge sensitive-badge-${finding.kind}`}>
      {KIND_LABELS[finding.kind]}
      {finding.count > 1 ? ` ×${finding.count}` : ""}
    </span>
  );
}

/** One flagged file's row: a small thumbnail/icon, its name + folder, and
 *  every masked finding in it as a badge row underneath. No checkbox, no
 *  selection, no delete action - unlike DuplicatesView, this view never
 *  acts on a file by itself. It's a warning to read before *you* zip it up
 *  or share it somewhere, not a cleanup tool. */
function FlaggedFileRow({
  file,
  onOpen,
  onContextMenu,
}: {
  file: SensitiveFlaggedFile;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const ext = extOf(file.filename);
  const renderKind: GridItem["kind"] =
    file.kind === "image" ? "image" : ext === ".pdf" ? "pdf" : ext === ".md" || ext === ".txt" ? "text" : "other";
  const gridItem: GridItem = {
    path: file.path,
    name: file.filename,
    isDirectory: false,
    kind: renderKind,
  };

  return (
    <div className="sensitive-row" onContextMenu={onContextMenu}>
      <div className="sensitive-row-thumb" onDoubleClick={onOpen} title="Double-click to open">
        {renderKind === "image" ? (
          <ImageTile item={gridItem} />
        ) : renderKind === "pdf" ? (
          <IconPdf size={22} className="tile-icon-glyph" />
        ) : renderKind === "text" ? (
          <IconFile size={22} className="tile-icon-glyph" />
        ) : (
          <IconOther size={22} className="tile-icon-glyph" />
        )}
      </div>
      <div className="sensitive-row-info">
        <div className="sensitive-row-name" title={file.path}>
          {file.filename}
        </div>
        <div className="sensitive-row-dir" title={file.path}>
          {dirOf(file.path)}
        </div>
        <div className="sensitive-row-badges">
          {file.findings.map((f, i) => (
            <FindingBadge key={`${f.kind}-${i}`} finding={f} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SensitiveScanView({
  currentDir,
  loading,
  data,
}: {
  currentDir: string;
  loading: boolean;
  data: SensitiveScanResponse | null;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(
    null
  );

  const contextMenuItems: ContextMenuItem[] = contextMenu
    ? [
        { label: "Open", onClick: () => window.smartsearch.openPath(contextMenu.path) },
        {
          label: window.smartsearch.platform === "darwin" ? "Show in Finder" : "Show in File Explorer",
          onClick: () => window.smartsearch.showInFolder(contextMenu.path),
        },
      ]
    : [];

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconWarning size={40} />
        </div>
        <div>Scanning {basename(currentDir)} for sensitive content…</div>
      </div>
    );
  }

  if (!data || data.flagged_files.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconWarning size={40} />
        </div>
        <div>
          Nothing flagged here — no SSNs, card numbers, routing numbers, or private keys found in
          this folder's indexed text.
        </div>
      </div>
    );
  }

  const totalFindings = data.flagged_files.reduce(
    (n, f) => n + f.findings.reduce((m, x) => m + x.count, 0),
    0
  );

  return (
    <div className="sensitive-view">
      <div className="sensitive-summary">
        <IconWarning size={16} />
        <span>
          {data.flagged_files.length} file{data.flagged_files.length === 1 ? "" : "s"} flagged •{" "}
          {totalFindings} thing{totalFindings === 1 ? "" : "s"} found. Worth a look before you zip
          up or share this folder — nothing here was changed or sent anywhere.
        </span>
      </div>
      <div className="sensitive-rows">
        {data.flagged_files.map((file) => (
          <FlaggedFileRow
            key={file.path}
            file={file}
            onOpen={() => window.smartsearch.openPath(file.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, path: file.path });
            }}
          />
        ))}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

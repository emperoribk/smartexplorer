import React, { useState } from "react";
import { IconChevron } from "./Icons";
import { vaultTempRootOf, vaultTopName, vaultSubCrumbs } from "../vaultTemp";
import { hasInternalDragPayload, readDropPayload, type VaultEntryDragPayload } from "../dragDrop";

/** Splits a path into clickable segments, handling both POSIX (/a/b/c) and
 *  Windows (C:\a\b\c) separators so the same component works on both OSes. */
function segments(fullPath: string, platform: string): { label: string; path: string }[] {
  const isWindows = platform === "win32";
  const sep = isWindows ? "\\" : "/";
  const parts = fullPath.split(/[\\/]/).filter(Boolean);

  const crumbs: { label: string; path: string }[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    if (isWindows && i === 0) {
      acc = parts[0] + sep; // "C:" -> "C:\"
    } else {
      acc = acc.endsWith(sep) ? acc + parts[i] : acc + sep + parts[i];
    }
    crumbs.push({ label: parts[i], path: acc });
  }
  if (!isWindows) crumbs.unshift({ label: "/", path: "/" });
  return crumbs;
}

/** Copies text to the system clipboard. Tries the standard web API first
 *  (works fine from a click handler in Electron's renderer) and falls back
 *  to the old textarea+execCommand trick if that's ever unavailable. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy fallback below
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return true;
  } catch {
    return false;
  }
}

export function Breadcrumb({
  path,
  platform,
  onNavigate,
  onMoveInto,
  onRestoreVaultEntry,
  onOpenVault,
}: {
  path: string;
  platform: string;
  onNavigate: (path: string) => void;
  /** A file dragged from the grid (see FileGrid.tsx's Tile) dropped onto
   *  one of this breadcrumb's non-ellipsis segments - moves it into that
   *  ancestor folder, same as dropping it on a Sidebar row or a FileGrid
   *  directory tile. */
  onMoveInto: (paths: string[], destDir: string) => void;
  /** A "Your Eyes Only" vault row (see VaultView.tsx's VaultRow) dropped
   *  onto one of these segments instead - restores that locked file
   *  straight into that ancestor folder, after a fresh credential check
   *  (see App.tsx's handleRestoreVaultEntry). */
  onRestoreVaultEntry: (entry: VaultEntryDragPayload, destDir: string) => void;
  /** Goes back to the Your Eyes Only list. Used by the first crumb while
   *  browsing a locked folder's contents. */
  onOpenVault: () => void;
}) {
  const sandboxed = vaultTempRootOf(path) !== null;
  if (sandboxed) {
    // A locked folder's contents are shown as "Your Eyes Only > Name > ...",
    // never as the real temp location, and nothing above the locked folder
    // can be reached from here - the only way out is back to Your Eyes Only.
    const topRoot = vaultTempRootOf(path)!;
    const trail = [
      { label: "Your Eyes Only", path: "", back: true },
      { label: vaultTopName(path), path: topRoot, back: false },
      ...vaultSubCrumbs(path).map((c) => ({ ...c, back: false })),
    ];
    const shown = trail.length > 3 ? [trail[0], ...trail.slice(-2)] : trail;
    return (
      <div className="breadcrumb">
        {shown.map((c, i) => {
          const isLast = i === shown.length - 1;
          return (
            <React.Fragment key={`${i}:${c.path}`}>
              {i > 0 && <IconChevron size={13} className="breadcrumb-sep" />}
              {i === 1 && trail.length > 3 && shown !== trail && (
                <>
                  <span className="breadcrumb-ellipsis breadcrumb-static">…</span>
                  <IconChevron size={13} className="breadcrumb-sep" />
                </>
              )}
              <button
                className={`breadcrumb-item${isLast ? " breadcrumb-item-current" : ""}`}
                onClick={() => (c.back ? onOpenVault() : onNavigate(c.path))}
                title={c.label}
              >
                {c.label}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    );
  }
  const crumbs = segments(path, platform);
  const [copied, setCopied] = useState(false);
  // Which segment (by path) is currently being dragged over - at most one
  // at a time, so a single string beats a per-button boolean state each.
  const [dropHoverPath, setDropHoverPath] = useState<string | null>(null);

  // Only show the immediate parent and the current folder - a long path
  // (drive letter, every ancestor down to Downloads\smartsearch\...) just
  // adds noise nobody reads. Everything above that collapses behind a
  // single "…" that copies the full path to the clipboard when tapped, for
  // the times someone actually needs it.
  const hiddenCount = crumbs.length - 2;
  const visible = hiddenCount > 0 ? crumbs.slice(-2) : crumbs;

  const handleCopyFull = async () => {
    const ok = await copyToClipboard(path);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="breadcrumb">
      {hiddenCount > 0 && (
        <>
          <button
            type="button"
            className="breadcrumb-ellipsis"
            onClick={() => void handleCopyFull()}
            title={`${path}\nCopy full path`}
          >
            {copied ? "Copied!" : "…"}
          </button>
          <IconChevron size={13} className="breadcrumb-sep" />
        </>
      )}
      {visible.map((c, i) => {
        const isLast = i === visible.length - 1;
        return (
          <React.Fragment key={c.path}>
            {i > 0 && <IconChevron size={13} className="breadcrumb-sep" />}
            <button
              className={`breadcrumb-item${isLast ? " breadcrumb-item-current" : ""}${
                dropHoverPath === c.path ? " breadcrumb-item-drop-hover" : ""
              }`}
              onClick={() => onNavigate(c.path)}
              title={c.path}
              onDragOver={(e) => {
                if (!hasInternalDragPayload(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropHoverPath(c.path);
              }}
              onDragLeave={() => setDropHoverPath((p) => (p === c.path ? null : p))}
              onDrop={(e) => {
                e.preventDefault();
                setDropHoverPath((p) => (p === c.path ? null : p));
                const payload = readDropPayload(e);
                if (payload?.kind === "move") onMoveInto(payload.paths, c.path);
                else if (payload?.kind === "vault") onRestoreVaultEntry(payload.entry, c.path);
              }}
            >
              {c.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

import React, { useEffect, useRef } from "react";
import { IconTrash, IconWarning } from "./Icons";

export interface ConfirmDialogProps {
  /** Short heading, e.g. "Move 3 files to the Recycle Bin?" */
  title: string;
  /** Optional extra detail shown under the title - e.g. the file name(s)
   *  involved, so a person can double-check what's about to happen without
   *  having to remember what they selected. */
  detail?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button and icon as a destructive action (red)
   *  rather than the default accent color. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A small centered modal that replaces the browser/OS-native
 *  `window.confirm()` for anything destructive (deleting files) - styled to
 *  match the rest of the app instead of popping up as a bare system dialog.
 *  Confirms on Enter, cancels on Escape or a click on the dimmed backdrop,
 *  and traps focus on its own confirm button so a stray keypress can't land
 *  somewhere else in the app underneath it. */
export function ConfirmDialog({
  title,
  detail,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onConfirm, onCancel]);

  return (
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className={`confirm-dialog-icon${danger ? " confirm-dialog-icon-danger" : ""}`}>
          {danger ? <IconTrash size={22} /> : <IconWarning size={22} />}
        </div>
        <div className="confirm-dialog-body">
          <div id="confirm-dialog-title" className="confirm-dialog-title">
            {title}
          </div>
          {detail && <div className="confirm-dialog-detail">{detail}</div>}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`confirm-dialog-btn confirm-dialog-btn-primary${danger ? " confirm-dialog-btn-danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

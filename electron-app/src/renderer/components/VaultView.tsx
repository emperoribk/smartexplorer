import React, { useCallback, useEffect, useRef, useState } from "react";
import type { BackendClient } from "../api";
import type { SensitiveFinding, VaultEntry, VaultStatus } from "../types";
import { IconLock, IconLockOpen, IconWarning, IconFolder } from "./Icons";
import { VAULT_ENTRY_MIME } from "../dragDrop";

/** Same labels as SensitiveScanView's KIND_LABELS - vault.py's VaultEntry
 *  .reasons is just the list of sensitive.py finding kinds that got this
 *  file locked in the first place, so the same short labels apply. Kept
 *  as its own small copy (not imported) since this view has no other
 *  reason to depend on SensitiveScanView, matching how DuplicatesView and
 *  SensitiveScanView each keep their own small formatSize/basename rather
 *  than sharing a utils module. */
const REASON_LABELS: Record<string, string> = {
  ssn: "SSN",
  credit_card: "Card",
  routing_number: "Routing #",
  private_key: "Private key",
  manual: "Manually added",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

function formatSize(bytes: number): string {
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

function formatLockedAt(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

type CredentialAction =
  | { kind: "open"; entry: VaultEntry }
  | { kind: "restore"; entry: VaultEntry };

export const PIN_LENGTH = 5;

/** Five one-digit boxes for a PIN. Digits only; typing moves to the next
 *  box, Backspace steps back, pasting fills them all. The value is always
 *  a contiguous string (no gaps), so focus is kept on the first empty box. */
export function PinBoxes({
  value,
  onChange,
  onEnter,
  onEscape,
  autoFocus,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
  label: string;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  const focusBox = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(PIN_LENGTH - 1, i))];
    el?.focus();
    el?.select();
  };

  return (
    <div className="pin-boxes" role="group" aria-label={label}>
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete="off"
          className={`pin-box${value[i] ? " pin-box-filled" : ""}`}
          aria-label={`${label}, digit ${i + 1} of ${PIN_LENGTH}`}
          value={value[i] ?? ""}
          onFocus={(e) => {
            // Never let focus land past the first empty box.
            if (i > value.length) focusBox(value.length);
            else e.currentTarget.select();
          }}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "");
            if (!digits) return;
            const digit = digits[digits.length - 1];
            const next = (value.slice(0, i) + digit + value.slice(i + 1)).slice(0, PIN_LENGTH);
            onChange(next);
            if (i < PIN_LENGTH - 1) focusBox(i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              if (value[i]) {
                onChange(value.slice(0, i) + value.slice(i + 1));
              } else if (i > 0) {
                onChange(value.slice(0, i - 1) + value.slice(i));
                focusBox(i - 1);
              }
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              focusBox(i - 1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              focusBox(Math.min(i + 1, value.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              onEnter?.();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onEscape?.();
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, PIN_LENGTH);
            if (!digits) return;
            onChange(digits);
            focusBox(Math.min(digits.length, PIN_LENGTH - 1));
          }}
        />
      ))}
    </div>
  );
}

/** A focused PIN/password prompt, reused for session-unlock and for the
 *  per-file fresh check that /vault/open and /vault/restore always do
 *  regardless of session state (see vault.py's module docstring on why
 *  that re-check exists - it's the specific thing standing between a
 *  stranger holding an already-unlocked laptop and an actual sensitive
 *  file). Same visual chrome as ConfirmDialog (confirm-dialog-* classes)
 *  so it doesn't look like a one-off, but with its own input field. */
export function CredentialPrompt({
  method,
  title,
  detail,
  confirmLabel = "Unlock",
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  method: "pin" | "dpapi";
  title: string;
  detail?: React.ReactNode;
  confirmLabel?: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ready = method === "pin" ? value.length === PIN_LENGTH : value.length > 0;

  const submit = useCallback(() => {
    if (!ready || submitting) return;
    onSubmit(value);
  }, [value, ready, submitting, onSubmit]);

  return (
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="vault-prompt-title">
        <div className="confirm-dialog-icon">
          <IconLock size={20} />
        </div>
        <div className="confirm-dialog-body">
          <div id="vault-prompt-title" className="confirm-dialog-title">
            {title}
          </div>
          {detail && <div className="confirm-dialog-detail">{detail}</div>}
          {method === "pin" ? (
            <PinBoxes value={value} onChange={setValue} onEnter={submit} onEscape={onCancel} autoFocus label="Your PIN" />
          ) : (
            <input
              ref={inputRef}
              type="password"
              className="vault-prompt-input"
              placeholder="Your Windows password"
              value={value}
              autoComplete="off"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />
          )}
          {error && <div className="vault-prompt-error">{error}</div>}
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-primary"
            disabled={!ready || submitting}
            onClick={submit}
          >
            {submitting ? "Checking…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** First-time setup. By default: check whether the signed-in Windows
 *  account already has a login password and, if so, reuse it (method
 *  "dpapi" - see vault.py's setup_with_windows_account); if there isn't
 *  one, ask the person to choose a PIN (method "pin"). Because some
 *  machines have no usable Windows password (Windows Hello PIN only, a
 *  Microsoft account whose password isn't known, Windows Sandbox, work
 *  accounts), the password screen also offers "choose a PIN instead". */
function VaultSetup({
  status,
  onSetUp,
}: {
  status: VaultStatus;
  onSetUp: (args: { method: "pin" | "dpapi"; pin?: string; windowsPassword?: string }) => Promise<void>;
}) {
  const [started, setStarted] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [windowsPassword, setWindowsPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // null means "couldn't tell" (e.g. not running on Windows in dev) -
  // treated the same as "no password" so setup can still proceed with a
  // PIN rather than getting stuck.
  const [forcePin, setForcePin] = useState(false);
  const usesWindowsPassword = status.windows_has_password === true && !forcePin;

  const submit = async () => {
    setError(null);
    if (usesWindowsPassword) {
      if (!windowsPassword) return;
      setSubmitting(true);
      try {
        await onSetUp({ method: "dpapi", windowsPassword });
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (pin.length !== PIN_LENGTH) {
      setError(`Enter all ${PIN_LENGTH} digits of your PIN.`);
      return;
    }
    if (pin !== pinConfirm) {
      setError("Those two PINs don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await onSetUp({ method: "pin", pin });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!started) {
    return (
      <div className="vault-intro">
        <div className="vault-intro-icon">
          <IconLock size={32} />
        </div>
        <div className="vault-intro-title">Your Eyes Only</div>
        <p className="vault-intro-text">
          A private place for files and folders you choose to lock. Anything you send here is
          encrypted on this computer, and nothing is moved here automatically. Opening or restoring
          a file asks for your password or PIN again.
        </p>
        <p className="vault-intro-text">
          {usesWindowsPassword
            ? "Your Windows account has a sign-in password, so Your Eyes Only will reuse that - nothing new to remember. You can choose a separate 5-digit PIN instead on the next screen."
            : status.windows_has_password === true
              ? "You'll choose a 5-digit PIN just for Your Eyes Only."
              : "Your Windows account doesn't have a sign-in password, so you'll choose a 5-digit PIN just for Your Eyes Only."}
        </p>
        <button type="button" className="vault-primary-btn" onClick={() => setStarted(true)}>
          Set up Your Eyes Only
        </button>
      </div>
    );
  }

  return (
    <div className="vault-intro">
      <div className="vault-intro-icon">
        <IconLock size={32} />
      </div>
      <div className="vault-intro-title">
        {usesWindowsPassword ? "Confirm your Windows password" : `Choose a ${PIN_LENGTH}-digit PIN`}
      </div>
      {usesWindowsPassword ? (
        <>
          <p className="vault-intro-text">
            Type your Windows password once to confirm it - Your Eyes Only will use it to lock and
            unlock flagged files, the same password you already sign in with.
          </p>
          <input
            type="password"
            className="vault-prompt-input vault-setup-input"
            placeholder="Your Windows password"
            autoComplete="off"
            autoFocus
            value={windowsPassword}
            onChange={(e) => setWindowsPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            type="button"
            className="vault-link-btn"
            onClick={() => {
              setError(null);
              setForcePin(true);
            }}
          >
            I don't have a Windows password, or I sign in with a PIN - choose a 5-digit PIN instead
          </button>
        </>
      ) : (
        <>
          <p className="vault-intro-text">
            Pick a {PIN_LENGTH}-digit PIN you won't forget but a stranger wouldn't guess. There's no
            "forgot PIN" recovery by design, so keep it somewhere safe too.
          </p>
          <div className="pin-label">Enter a {PIN_LENGTH}-digit PIN</div>
          <PinBoxes value={pin} onChange={setPin} onEnter={submit} autoFocus label={`Choose a ${PIN_LENGTH}-digit PIN`} />
          <div className="pin-label">Enter it again to confirm</div>
          <PinBoxes value={pinConfirm} onChange={setPinConfirm} onEnter={submit} label="Confirm PIN" />
          {forcePin && (
            <button
              type="button"
              className="vault-link-btn"
              onClick={() => {
                setError(null);
                setForcePin(false);
              }}
            >
              Use my Windows password instead
            </button>
          )}
        </>
      )}
      {error && <div className="vault-prompt-error">{error}</div>}
      <div className="vault-intro-actions">
        <button type="button" className="confirm-dialog-btn" onClick={() => setStarted(false)}>
          Back
        </button>
        <button type="button" className="vault-primary-btn" disabled={submitting} onClick={submit}>
          {submitting ? "Setting up…" : "Finish setup"}
        </button>
      </div>
    </div>
  );
}

function VaultUnlock({
  status,
  onUnlock,
}: {
  status: VaultStatus;
  onUnlock: (args: { pin?: string; windowsPassword?: string }) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = status.method ?? "pin";

  const submit = async () => {
    if (!value || submitting) return;
    if (method !== "dpapi" && value.length !== PIN_LENGTH) return;
    setSubmitting(true);
    setError(null);
    try {
      if (method === "dpapi") await onUnlock({ windowsPassword: value });
      else await onUnlock({ pin: value });
    } catch {
      setError(method === "dpapi" ? "Wrong Windows password." : "Wrong PIN.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="vault-intro">
      <div className="vault-intro-icon">
        <IconLock size={32} />
      </div>
      <div className="vault-intro-title">Your Eyes Only is locked</div>
      <p className="vault-intro-text">
        {method === "dpapi"
          ? "Enter your Windows password to see what's in here."
          : "Enter your PIN to see what's in here."}
      </p>
      {method === "dpapi" ? (
        <input
          type="password"
          className="vault-prompt-input vault-setup-input"
          placeholder="Your Windows password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      ) : (
        <PinBoxes value={value} onChange={setValue} onEnter={submit} autoFocus label="Your PIN" />
      )}
      {error && <div className="vault-prompt-error">{error}</div>}
      <button
        type="button"
        className="vault-primary-btn"
        disabled={(method === "dpapi" ? !value : value.length !== PIN_LENGTH) || submitting}
        onClick={submit}
      >
        {submitting ? "Checking…" : "Unlock"}
      </button>
    </div>
  );
}

function ReasonBadge({ reason }: { reason: string }) {
  const kind = reason as SensitiveFinding["kind"];
  return <span className={`sensitive-badge sensitive-badge-${kind}`}>{reasonLabel(reason)}</span>;
}

function VaultRow({
  entry,
  onOpen,
  onRestore,
}: {
  entry: VaultEntry;
  onOpen: () => void;
  onRestore: () => void;
}) {
  return (
    <div
      className="vault-row"
      draggable
      title="Drag onto a folder in the sidebar or breadcrumb to restore it straight there"
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          VAULT_ENTRY_MIME,
          JSON.stringify({ entryId: entry.id, filename: entry.filename, root: entry.root })
        );
      }}
    >
      <div className="vault-row-thumb">
        {entry.is_folder ? <IconFolder size={20} /> : <IconLock size={20} />}
      </div>
      <div className="vault-row-info">
        <div className="vault-row-name" title={entry.filename}>
          <span className="vault-row-name-text">{entry.filename}</span>
          {entry.is_folder && <span className="vault-row-folder-tag">Folder</span>}
        </div>
        <div className="vault-row-meta">
          {formatSize(entry.size)} • Locked {formatLockedAt(entry.locked_at)}
        </div>
        {entry.original_path && (
          <div className="vault-row-meta" title={entry.original_path}>
            From {entry.original_path}
          </div>
        )}
        <div className="vault-row-badges">
          {/* Unique kinds only - an entry vaulted before this dedup was
             added server-side (see main.py's get_sensitive_scan) can still
             have the same reason listed several times (one per distinct
             matched number of that kind), which used to stack the same
             badge repeatedly on one row ("Card Card Card"). Deduping here
             too means an already-vaulted entry displays correctly right
             away, without needing to be restored and re-locked. */}
          {Array.from(new Set(entry.reasons)).map((r) => (
            <ReasonBadge key={r} reason={r} />
          ))}
        </div>
      </div>
      <div className="vault-row-actions">
        <button type="button" className="vault-row-btn" onClick={onOpen} title="Decrypt and open">
          <IconLockOpen size={14} />
          <span>Open</span>
        </button>
        <button
          type="button"
          className="vault-row-btn"
          onClick={onRestore}
          title="Decrypt and put back in its original folder"
        >
          <span>Restore</span>
        </button>
      </div>
    </div>
  );
}

/** "Your Eyes Only" - the hidden, encrypted vault flagged files get moved
 *  into (see vault.py). Unlike DuplicatesView/SensitiveScanView, this
 *  isn't a plain presentational view driven entirely by props - setup,
 *  unlock, open, and restore are all real side-effecting actions with
 *  their own credential prompts, so this component talks to the backend
 *  client directly rather than through a pile of callback props threaded
 *  from App.tsx. */
export function VaultView({
  currentDir,
  knownFolders,
  client,
  onOpenFolder,
  onOpenFile,
}: {
  currentDir: string;
  /** Folders the app has seen - any that hold a vault are listed too. */
  knownFolders: string[];
  client: BackendClient;
  /** Called with the decrypted temp folder when a locked FOLDER is opened,
   *  so it is browsed inside SmartExplorer (in a new tab) rather than being
   *  handed to Windows Explorer - which may not even be there. */
  onOpenFolder: (tempPath: string, name: string) => void | Promise<void>;
  /** Called with the decrypted temp file for a single locked FILE. Shows it
   *  inside SmartExplorer (image, video, PDF, text) and returns true; returns
   *  false when the app has no viewer for that type, and the file is then
   *  opened with its default app instead. */
  onOpenFile: (tempPath: string, name: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<CredentialAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const s = await client.getVaultStatus();
      setStatus(s);
      if (!s.set_up) {
        setEntries(null);
        setNeedsUnlock(false);
        return;
      }
      try {
        const list = await client.getVaultListAll([currentDir, ...knownFolders].filter(Boolean));
        setEntries(list.entries);
        setNeedsUnlock(false);
      } catch (err) {
        if (err instanceof Error && err.message === "unlock_required") {
          setNeedsUnlock(true);
          setEntries(null);
        } else {
          throw err;
        }
      }
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err));
    }
  }, [client, currentDir, knownFolders]);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const handleSetUp = async (args: { method: "pin" | "dpapi"; pin?: string; windowsPassword?: string }) => {
    await client.setupVault(args);
    await refresh();
  };

  const handleUnlock = async (args: { pin?: string; windowsPassword?: string }) => {
    await client.unlockVault(args);
    await refresh();
  };

  const handleLockNow = async () => {
    await client.lockVaultNow();
    setNotice(null);
    await refresh();
  };

  const submitAction = async (value: string) => {
    if (!action) return;
    setActionSubmitting(true);
    setActionError(null);
    const method = status?.method === "dpapi" ? "dpapi" : "pin";
    const creds = method === "dpapi" ? { windowsPassword: value } : { pin: value };
    try {
      if (action.kind === "open") {
        const res = await client.openVaultFile({ rootPath: action.entry.root ?? currentDir, entryId: action.entry.id, ...creds });
        if (action.entry.is_folder) {
          await onOpenFolder(res.temp_path, action.entry.filename);
          setNotice(
            `Opened "${action.entry.filename}" in a new tab - the decrypted copy is deleted when you close that tab.`
          );
        } else if (await onOpenFile(res.temp_path, action.entry.filename)) {
          setNotice(`Opened "${action.entry.filename}" - the decrypted copy is deleted when you close the preview.`);
        } else {
          await window.smartsearch.openVaultTemp(res.temp_path);
          setNotice(
            `SmartExplorer can't show this file type itself, so "${action.entry.filename}" was opened with its default app - the decrypted copy is cleaned up automatically.`
          );
        }
      } else {
        const res = await client.restoreVaultFile({ rootPath: action.entry.root ?? currentDir, entryId: action.entry.id, ...creds });
        setNotice(`Restored to its original folder: ${res.restored_path}`);
        setEntries((prev) => prev?.filter((e) => e.id !== action.entry.id) ?? null);
      }
      setAction(null);
    } catch (err) {
      setActionError(
        err instanceof Error && err.message === "wrong_credential"
          ? method === "dpapi"
            ? "Wrong Windows password."
            : "Wrong PIN."
          : String(err instanceof Error ? err.message : err)
      );
    } finally {
      setActionSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconLock size={40} />
        </div>
        <div>Checking Your Eyes Only…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="empty-state">
        <div className="empty-state-glyph">
          <IconWarning size={40} />
        </div>
        <div>Couldn't reach Your Eyes Only: {loadError}</div>
      </div>
    );
  }

  if (status && !status.set_up) {
    return (
      <div className="vault-view">
        <VaultSetup status={status} onSetUp={handleSetUp} />
      </div>
    );
  }

  if (needsUnlock && status) {
    return (
      <div className="vault-view">
        <VaultUnlock status={status} onUnlock={handleUnlock} />
      </div>
    );
  }

  return (
    <div className="vault-view">
      <div className="vault-summary">
        <IconLock size={16} />
        <span>
          {entries?.length ?? 0} file{(entries?.length ?? 0) === 1 ? "" : "s"} hidden here, encrypted at
          rest. Opening or restoring one always re-asks for your {status?.method === "dpapi" ? "Windows password" : "PIN"} -
          staying unlocked to browse this list doesn't skip that.
        </span>
        <button type="button" className="vault-lock-now-btn" onClick={handleLockNow}>
          Lock now
        </button>
      </div>
      {notice && <div className="vault-notice">{notice}</div>}
      {entries && entries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-glyph">
            <IconLock size={40} />
          </div>
          <div>Nothing hidden here right now.</div>
        </div>
      ) : (
        <div className="vault-rows">
          {entries?.map((entry) => (
            <VaultRow
              key={entry.id}
              entry={entry}
              onOpen={() => {
                setActionError(null);
                setAction({ kind: "open", entry });
              }}
              onRestore={() => {
                setActionError(null);
                setAction({ kind: "restore", entry });
              }}
            />
          ))}
        </div>
      )}
      {action && status && (
        <CredentialPrompt
          method={status.method === "dpapi" ? "dpapi" : "pin"}
          title={action.kind === "open" ? `Open "${action.entry.filename}"` : `Restore "${action.entry.filename}"`}
          detail={
            action.kind === "open"
              ? "Opens a decrypted copy with its normal app. Looks completely ordinary once open."
              : "Decrypts it and puts it back in its original folder, no longer hidden."
          }
          confirmLabel={action.kind === "open" ? "Open" : "Restore"}
          submitting={actionSubmitting}
          error={actionError}
          onSubmit={submitAction}
          onCancel={() => {
            setAction(null);
            setActionError(null);
          }}
        />
      )}
    </div>
  );
}

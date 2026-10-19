/** Helpers for the temporary, decrypted copy of a locked folder (see
 *  vaultBridge.ts / vault.py's unlock_to_temp). That copy lives in a folder
 *  under the OS temp directory, but the person is never meant to see or
 *  navigate that location: the app presents it as "Your Eyes Only > <name>".
 *  Everything that would otherwise show or leave through that real path goes
 *  through these helpers. */

const VAULT_TEMP_RE = /[\\/]smartexplorer-vault([\\/]|$)/i;

export const isVaultTempPath = (p: string): boolean => VAULT_TEMP_RE.test(p);

/** The decrypted copy's own top folder (…\smartexplorer-vault\<id>_<name>)
 *  for any path inside it, or null for any other path. */
export function vaultTempRootOf(p: string): string | null {
  const m = /^(.*[\\/]smartexplorer-vault[\\/][^\\/]+)(?:[\\/].*)?$/i.exec(p);
  return m ? m[1] : null;
}

/** "<32 hex id>_Taxes" -> "Taxes": the temp folder is prefixed with the
 *  entry id so two entries can never collide; that prefix is not a name. */
export function vaultDisplayName(folderName: string): string {
  return folderName.replace(/^[0-9a-f]{32}_/i, "");
}

/** Path segments below the decrypted copy's top folder, e.g.
 *  [{label:"Receipts", path:"…\\Receipts"}]. */
export function vaultSubCrumbs(p: string): { label: string; path: string }[] {
  const root = vaultTempRootOf(p);
  if (!root) return [];
  const rest = p.slice(root.length).split(/[\\/]/).filter(Boolean);
  const sep = p.includes("\\") ? "\\" : "/";
  const out: { label: string; path: string }[] = [];
  let acc = root;
  for (const part of rest) {
    acc = acc + sep + part;
    out.push({ label: part, path: acc });
  }
  return out;
}

export function vaultTopName(p: string): string {
  const root = vaultTempRootOf(p);
  if (!root) return "";
  return vaultDisplayName(root.split(/[\\/]/).filter(Boolean).pop() ?? "");
}

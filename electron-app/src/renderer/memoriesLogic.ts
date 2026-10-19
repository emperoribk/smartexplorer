import type { MemoryCard } from "./types";

/** Memories are opt-out: on unless the person turns them off. */
export const MEMORIES_ENABLED_KEY = "smartexplorer.memoriesEnabled";
/** id -> epoch ms at which the "Not now" snooze expires. */
export const MEMORIES_DISMISSED_KEY = "smartexplorer.memoriesDismissed";
/** A dismissed card stays away this long (then it may come back). */
export const SNOOZE_MS = 90 * 86400_000;

export type DismissedMap = Record<string, number>;

/** Reads the dismissed map, dropping entries whose snooze has expired so
 *  the stored object can't grow forever. Never throws. */
export function loadDismissed(now: number = Date.now()): DismissedMap {
  try {
    const raw = window.localStorage.getItem(MEMORIES_DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DismissedMap = {};
    for (const [id, until] of Object.entries(parsed)) {
      if (typeof until === "number" && until > now) out[id] = until;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDismissed(map: DismissedMap): void {
  try {
    window.localStorage.setItem(MEMORIES_DISMISSED_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable - snoozes just won't persist
  }
}

function normFolder(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Which cards are actually worth showing right now: not snoozed, and - for
 *  "you haven't opened this folder" cards - not a folder the person has
 *  visited recently in the app (that would be untrue). */
export function visibleCards(
  cards: MemoryCard[],
  dismissed: DismissedMap,
  recentFolders: string[],
  now: number = Date.now()
): MemoryCard[] {
  const recent = new Set(recentFolders.map(normFolder));
  return cards.filter((c) => {
    const until = dismissed[c.id];
    if (until !== undefined && until > now) return false;
    if (c.type === "stale_folder" && c.folder && recent.has(normFolder(c.folder))) return false;
    return true;
  });
}

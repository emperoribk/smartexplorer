/**
 * Appearance: the white/dark theme (handled in App.tsx via <html data-theme>)
 * plus a user-chosen accent colour.
 *
 * The accent is picked as a hue (a preset, or any hue from the Settings
 * slider) and turned into the handful of CSS variables the stylesheet already
 * reads (--accent, --accent-strong, --accent-soft ...). Whatever the person
 * picks, the colours are nudged until text on top of the accent is readable
 * (WCAG AA, 4.5:1) - so a yellow or a neon green never ends up with
 * unreadable button labels. Nothing here touches the white/dark backgrounds.
 */

export type Theme = "light" | "dark";

export type AccentId =
  | "blue"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "green"
  | "teal"
  | "mono"
  | "custom";

export interface AccentPreset {
  id: Exclude<AccentId, "custom">;
  name: string;
  h: number;
  s: number;
  /** Black in white mode, white in dark mode - no hue at all. */
  mono?: boolean;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "blue", name: "Blue", h: 208, s: 88 },
  { id: "purple", name: "Purple", h: 268, s: 78 },
  { id: "pink", name: "Pink", h: 328, s: 80 },
  { id: "red", name: "Red", h: 356, s: 72 },
  { id: "orange", name: "Orange", h: 24, s: 92 },
  { id: "green", name: "Green", h: 150, s: 70 },
  { id: "teal", name: "Teal", h: 178, s: 80 },
  { id: "mono", name: "Black / White", h: 220, s: 14, mono: true },
];

export const ACCENT_KEY = "smartexplorer.accent";
export const ACCENT_HUE_KEY = "smartexplorer.accentHue";
export const DEFAULT_CUSTOM_HUE = 300;
const CUSTOM_SATURATION = 80;

export interface Appearance {
  accent: AccentId;
  /** Only used when accent === "custom". 0-360. */
  hue: number;
}

export const DEFAULT_APPEARANCE: Appearance = { accent: "blue", hue: DEFAULT_CUSTOM_HUE };

function isAccentId(v: unknown): v is AccentId {
  return v === "custom" || ACCENT_PRESETS.some((p) => p.id === v);
}

function clampHue(h: number): number {
  if (!Number.isFinite(h)) return DEFAULT_CUSTOM_HUE;
  return Math.min(360, Math.max(0, Math.round(h)));
}

export function loadAppearance(): Appearance {
  try {
    const rawAccent = window.localStorage.getItem(ACCENT_KEY);
    const rawHue = window.localStorage.getItem(ACCENT_HUE_KEY);
    return {
      accent: isAccentId(rawAccent) ? rawAccent : DEFAULT_APPEARANCE.accent,
      hue: rawHue === null ? DEFAULT_CUSTOM_HUE : clampHue(Number(rawHue)),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    window.localStorage.setItem(ACCENT_KEY, a.accent);
    window.localStorage.setItem(ACCENT_HUE_KEY, String(clampHue(a.hue)));
  } catch {
    // Storage unavailable (private mode etc.) - the choice just won't persist.
  }
}

// ---- colour maths (WCAG relative luminance / contrast) ----

type RGB = [number, number, number];

function hslToRgb(h: number, s: number, l: number): RGB {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function channel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(rgb: RGB): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const WHITE: RGB = [1, 1, 1];
const DARK_INK_HSL = { h: 220, s: 10, l: 8 };
const DARK_INK: RGB = hslToRgb(DARK_INK_HSL.h, DARK_INK_HSL.s, DARK_INK_HSL.l);

export interface AccentColors {
  /** Fill for buttons, the selected-item ring, toggles, the disk bar. */
  accent: string;
  /** Hover / pressed variant. */
  accentStrong: string;
  /** A faint tint for the active sidebar row, selected tiles, chips. */
  accentSoft: string;
  /** Text colour that sits on top of `accent`. */
  onAccent: string;
  /** Contrast ratio between `accent` and `onAccent` (always >= 4.5). */
  ratio: number;
  /** Display name for the Settings screen. */
  name: string;
}

/** The accent for a given theme. In white mode the colour is darkened until
 *  white text reads on it; in dark mode it is lightened until dark text does. */
export function accentColors(a: Appearance, theme: Theme): AccentColors {
  const preset = ACCENT_PRESETS.find((p) => p.id === a.accent);
  const dark = theme === "dark";

  if (preset?.mono) {
    return dark
      ? {
          accent: "hsl(220, 14%, 94%)",
          accentStrong: "hsl(220, 14%, 100%)",
          accentSoft: "rgba(255, 255, 255, 0.10)",
          onAccent: "hsl(220, 10%, 8%)",
          ratio: contrastRatio(hslToRgb(220, 14, 94), DARK_INK),
          name: preset.name,
        }
      : {
          accent: "hsl(220, 14%, 10%)",
          accentStrong: "hsl(220, 14%, 22%)",
          accentSoft: "rgba(20, 24, 31, 0.08)",
          onAccent: "#ffffff",
          ratio: contrastRatio(hslToRgb(220, 14, 10), WHITE),
          name: preset.name,
        };
  }

  const h = preset ? preset.h : clampHue(a.hue);
  const s = preset ? preset.s : CUSTOM_SATURATION;
  const name = preset ? preset.name : "Custom";

  if (!dark) {
    let l = 40;
    while (contrastRatio(hslToRgb(h, s, l), WHITE) < 4.5 && l > 14) l--;
    return {
      accent: `hsl(${h}, ${s}%, ${l}%)`,
      accentStrong: `hsl(${h}, ${s}%, ${Math.max(8, l - 7)}%)`,
      accentSoft: `hsla(${h}, ${s}%, ${Math.min(l + 4, 50)}%, 0.10)`,
      onAccent: "#ffffff",
      ratio: contrastRatio(hslToRgb(h, s, l), WHITE),
      name,
    };
  }

  const sd = Math.min(s, 85);
  let l = 58;
  while (contrastRatio(hslToRgb(h, sd, l), DARK_INK) < 4.5 && l < 90) l++;
  return {
    accent: `hsl(${h}, ${sd}%, ${l}%)`,
    accentStrong: `hsl(${h}, ${sd}%, ${Math.min(94, l + 8)}%)`,
    accentSoft: `hsla(${h}, ${sd}%, ${l}%, 0.18)`,
    onAccent: `hsl(${DARK_INK_HSL.h}, ${DARK_INK_HSL.s}%, ${DARK_INK_HSL.l}%)`,
    ratio: contrastRatio(hslToRgb(h, sd, l), DARK_INK),
    name,
  };
}

/** Writes the accent into <html>'s inline style, where it overrides the
 *  stylesheet's default blue. Safe to call as often as needed. */
export function applyAccent(a: Appearance, theme: Theme): AccentColors {
  const c = accentColors(a, theme);
  const style = document.documentElement.style;
  style.setProperty("--accent", c.accent);
  style.setProperty("--accent-strong", c.accentStrong);
  style.setProperty("--accent-soft", c.accentSoft);
  style.setProperty("--surface-active", c.accentSoft);
  style.setProperty("--accent-gradient", c.accent);
  style.setProperty("--on-accent", c.onAccent);
  return c;
}

/** The two accents (white mode and dark mode) for the theme preview tiles. */
export function accentPair(a: Appearance): { light: string; dark: string } {
  return { light: accentColors(a, "light").accent, dark: accentColors(a, "dark").accent };
}

// ---- other display preferences (Settings > Browsing) ----

export type ThumbSize = "small" | "medium" | "large";
export const THUMB_SIZE_KEY = "smartexplorer.thumbSize";
export const SHOW_EXT_KEY = "smartexplorer.showExtensions";
export const DETAILS_KEY = "smartexplorer.detailsPane";
export const SORT_KEY = "smartexplorer.sortKey";
export const GROUP_KEY = "smartexplorer.groupMode";

export function loadThumbSize(): ThumbSize {
  try {
    const v = window.localStorage.getItem(THUMB_SIZE_KEY);
    return v === "small" || v === "large" ? v : "medium";
  } catch {
    return "medium";
  }
}

export function saveSimple(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function loadSimple<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

import React from "react";
import {
  ACCENT_PRESETS,
  accentColors,
  accentPair,
  DEFAULT_CUSTOM_HUE,
  type Appearance,
  type Theme,
  type ThumbSize,
} from "../theme";
import { IconCheck, IconMoon, IconPictures, IconSparkle, IconSun, IconVideos } from "./Icons";
import type { AutoIndexStatus } from "../types";

/** Settings > Appearance and Browsing. Everything here applies instantly and
 *  is remembered between launches (App.tsx saves each choice). */
export function SettingsView({
  theme,
  onThemeChange,
  appearance,
  onAppearanceChange,
  thumbSize,
  onThumbSizeChange,
  showExtensions,
  onShowExtensionsChange,
  autoIndexEnabled,
  onAutoIndexChange,
  autoIndexStatus,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  appearance: Appearance;
  onAppearanceChange: (a: Appearance) => void;
  thumbSize: ThumbSize;
  onThumbSizeChange: (s: ThumbSize) => void;
  showExtensions: boolean;
  onShowExtensionsChange: (v: boolean) => void;
  autoIndexEnabled: boolean;
  onAutoIndexChange: (v: boolean) => void;
  autoIndexStatus: AutoIndexStatus | null;
}) {
  const current = accentColors(appearance, theme);
  const pair = accentPair(appearance);
  const custom = appearance.accent === "custom";

  const themeTile = (t: Theme, label: string) => {
    const on = theme === t;
    return (
      <button
        type="button"
        className={`settings-theme-tile${on ? " settings-theme-tile-on" : ""}`}
        aria-pressed={on}
        onClick={() => onThemeChange(t)}
      >
        <div className={`settings-mini settings-mini-${t}`} aria-hidden>
          <div className="settings-mini-side">
            <i />
            <i className="a" />
            <i />
            <i />
          </div>
          <div className="settings-mini-body">
            <u />
            <u className="a" />
            <u />
            <u />
          </div>
        </div>
        <span className="settings-theme-label">
          {t === "light" ? <IconSun size={14} /> : <IconMoon size={14} />}
          {label}
          {on && <IconCheck size={14} className="settings-theme-check" />}
        </span>
      </button>
    );
  };

  return (
    <div
      className="settings-scroll"
      style={{ ["--a-light" as string]: pair.light, ["--a-dark" as string]: pair.dark } as React.CSSProperties}
    >
      <div className="settings-wrap">
        <div className="settings-sec">
          <h2>Appearance</h2>
        </div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-label">
              <b>Theme</b>
              <span>The background of the whole app. Choose white or dark.</span>
            </div>
            <div className="settings-theme-tiles">
              {themeTile("light", "White")}
              {themeTile("dark", "Dark")}
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-label">
              <b>Accent color</b>
              <span>Used for buttons, selection and highlights. Pick a preset or make your own.</span>
            </div>
            <div>
              <div className="settings-swatches" role="radiogroup" aria-label="Accent color">
                {ACCENT_PRESETS.map((p) => {
                  const on = appearance.accent === p.id;
                  const c = accentColors({ accent: p.id, hue: appearance.hue }, theme).accent;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={p.name}
                      title={p.name}
                      className={`settings-swatch${p.mono ? " settings-swatch-mono" : ""}${on ? " settings-swatch-on" : ""}`}
                      style={{ ["--swatch" as string]: c } as React.CSSProperties}
                      onClick={() => onAppearanceChange({ accent: p.id, hue: appearance.hue })}
                    >
                      {on && <IconCheck size={16} />}
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="radio"
                  aria-checked={custom}
                  aria-label="Custom color"
                  title="Custom color"
                  className={`settings-swatch settings-swatch-custom${custom ? " settings-swatch-on" : ""}`}
                  onClick={() => onAppearanceChange({ accent: "custom", hue: appearance.hue || DEFAULT_CUSTOM_HUE })}
                >
                  {custom && <IconCheck size={16} />}
                </button>
              </div>

              {custom && (
                <div className="settings-hue">
                  <label htmlFor="settings-hue-slider">
                    <span>Hue</span>
                    <span>{appearance.hue}°</span>
                  </label>
                  <input
                    id="settings-hue-slider"
                    className="settings-hue-slider"
                    type="range"
                    min={0}
                    max={360}
                    value={appearance.hue}
                    onChange={(e) => onAppearanceChange({ accent: "custom", hue: Number(e.target.value) })}
                  />
                </div>
              )}

              <div className="settings-accent-name">
                <b>{current.name}</b>
                <span className="settings-ok" title="Text on buttons stays easy to read in every color you pick">
                  <IconCheck size={12} />
                  {current.ratio.toFixed(1)} : 1 text contrast
                </span>
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-label">
              <b>Preview</b>
              <span>How your choice looks on real parts of the app.</span>
            </div>
            <div className="settings-preview">
              <div className="settings-preview-col">
                <div className="settings-preview-nav">
                  <div className="settings-preview-nav-item settings-preview-nav-active">
                    <IconPictures size={16} />
                    Pictures
                  </div>
                  <div className="settings-preview-nav-item">
                    <IconVideos size={16} />
                    Videos
                  </div>
                </div>
                <div className="settings-preview-buttons">
                  <span className="settings-btn settings-btn-primary">Rename</span>
                  <span className="settings-btn settings-btn-outline">Open</span>
                </div>
                <div>
                  <div className="settings-preview-meter">
                    <i />
                  </div>
                  <div className="settings-preview-hint">168 GB free of 477 GB</div>
                </div>
                <div className="settings-preview-toggle">
                  <span className="settings-switch settings-switch-on" aria-hidden>
                    <i />
                  </span>
                  Smart naming
                </div>
              </div>
              <div className="settings-preview-col settings-preview-col-right">
                <div className="settings-preview-tile">
                  <div className="settings-preview-thumb">
                    <span className="settings-preview-tick">
                      <IconCheck size={12} />
                    </span>
                  </div>
                  <b>family-dinner</b>
                  <span>JPG · 2.8 MB</span>
                </div>
                <div className="settings-preview-smart">
                  <div className="settings-preview-smart-head">
                    <IconSparkle size={14} />
                    Smart name
                  </div>
                  <p>Fresh Market receipt — 12 Apr 2026.png</p>
                  <span className="settings-btn settings-btn-primary">Rename</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-sec">
          <h2>Browsing</h2>
        </div>
        <div className="settings-card">
          <div className="settings-row settings-row-center">
            <div className="settings-label">
              <b>Thumbnail size</b>
              <span>How big files and folders look in the grid.</span>
            </div>
            <div className="settings-seg" role="radiogroup" aria-label="Thumbnail size">
              {(["small", "medium", "large"] as ThumbSize[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={thumbSize === s}
                  className={thumbSize === s ? "settings-seg-on" : ""}
                  onClick={() => onThumbSizeChange(s)}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row settings-row-center">
            <div className="settings-label">
              <b>Show file extensions</b>
              <span>Show “.png”, “.pdf” and so on at the end of names.</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showExtensions}
              aria-label="Show file extensions"
              className={`settings-switch${showExtensions ? " settings-switch-on" : ""}`}
              onClick={() => onShowExtensionsChange(!showExtensions)}
            >
              <i />
            </button>
          </div>
        </div>
        <div className="settings-sec">
          <h2>Indexing</h2>
        </div>
        <div className="settings-card">
          <div className="settings-row settings-row-center">
            <div className="settings-label">
              <b>Index my main folders automatically</b>
              <span>{autoIndexSummary(autoIndexEnabled, autoIndexStatus)}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoIndexEnabled}
              aria-label="Index my main folders automatically"
              className={`settings-switch${autoIndexEnabled ? " settings-switch-on" : ""}`}
              onClick={() => onAutoIndexChange(!autoIndexEnabled)}
            >
              <i />
            </button>
          </div>
        </div>
        <div className="settings-end" />
      </div>
    </div>
  );
}

function folderName(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  return t.split(/[\\/]/).pop() || p;
}

function ago(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The one-line status under the "Index my main folders" switch. */
function autoIndexSummary(enabled: boolean, s: AutoIndexStatus | null): string {
  if (!enabled) {
    return "Off - a folder is only indexed once you open or search it.";
  }
  const base =
    "Documents, Pictures, Desktop, Downloads and Videos are indexed in the background, so search is ready straight away and only new files need catching up.";
  if (!s) return base;
  if (s.state === "waiting_model") return "Getting the photo-search model ready...";
  if (s.state === "indexing") {
    const where = s.current_root ? ` ${folderName(s.current_root)}:` : "";
    return `Indexing${where} ${s.overall_processed.toLocaleString()} of ${s.overall_total.toLocaleString()} files checked.`;
  }
  if (s.error) return `${base} Last problem: ${s.error}`;
  if (s.first_pass_done && s.last_finished) return `Up to date - last checked ${ago(s.last_finished)}.`;
  return base;
}

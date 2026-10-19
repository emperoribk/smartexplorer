import React from "react";

/**
 * A small hand-drawn icon set (stroke-based, 20x20, currentColor) so the app
 * doesn't lean on emoji for its chrome - keeps the UI feeling like a real
 * desktop app rather than a demo. Every icon takes the same {size, className}
 * props so they drop in anywhere interchangeably.
 */
type IconProps = { size?: number; className?: string };

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconHome({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M3 9.5 10 3l7 6.5" />
      <path d="M5 8.5V16a1 1 0 0 0 1 1h3v-4.5h2V17h3a1 1 0 0 0 1-1V8.5" />
    </svg>
  );
}

export function IconDesktop({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="2.5" y="4" width="15" height="10" rx="1.3" />
      <path d="M7 17.5h6M10 14v3.5" />
    </svg>
  );
}

export function IconDocuments({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M6 2.5h5.5L15 6v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />
      <path d="M11.3 2.5V6H15" />
      <path d="M6.7 10h6.2M6.7 12.6h6.2M6.7 15.2h4" />
    </svg>
  );
}

export function IconDownloads({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M10 3v9.5" />
      <path d="M6.3 9 10 12.7 13.7 9" />
      <path d="M3.5 14.5V16a1.3 1.3 0 0 0 1.3 1.3h10.4A1.3 1.3 0 0 0 16.5 16v-1.5" />
    </svg>
  );
}

export function IconPictures({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.3" />
      <circle cx="7.1" cy="8" r="1.4" />
      <path d="M3 15.3 8 10l3 3 2.5-2.5L17.5 15" />
    </svg>
  );
}

export function IconVideos({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="2.5" y="5" width="11" height="10" rx="1.3" />
      <path d="M13.5 8.3 17.5 6v8l-4-2.3" />
    </svg>
  );
}

export function IconFolder({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M2.5 5.3a1 1 0 0 1 1-1h4l1.6 2h7.4a1 1 0 0 1 1 1v7.9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5.3Z" />
    </svg>
  );
}

export function IconSparkle({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} fill="currentColor">
      <path d="M9.7 2.3c.15-.5.85-.5 1 0l1.1 3.6a3.6 3.6 0 0 0 2.4 2.4l3.6 1.1c.5.15.5.85 0 1l-3.6 1.1a3.6 3.6 0 0 0-2.4 2.4l-1.1 3.6c-.15.5-.85.5-1 0l-1.1-3.6a3.6 3.6 0 0 0-2.4-2.4l-3.6-1.1c-.5-.15-.5-.85 0-1l3.6-1.1a3.6 3.6 0 0 0 2.4-2.4l1.1-3.6Z" />
    </svg>
  );
}

export function IconSearch({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <circle cx="8.7" cy="8.7" r="5.4" />
      <path d="m17 17-3.9-3.9" />
    </svg>
  );
}

export function IconPlay({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} fill="currentColor">
      <path d="M6.5 4.3a1 1 0 0 1 1.53-.85l8.2 5.2a1 1 0 0 1 0 1.7l-8.2 5.2A1 1 0 0 1 6.5 14.7V4.3Z" />
    </svg>
  );
}

export function IconChevron({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="m7 4 6 6-6 6" />
    </svg>
  );
}

export function IconChevronDown({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="m4 7 6 6 6-6" />
    </svg>
  );
}

export function IconFile({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M6 2.5h5.5L15 6v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />
      <path d="M11.3 2.5V6H15" />
    </svg>
  );
}

export function IconPdf({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M6 2.5h5.5L15 6v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" />
      <path d="M11.3 2.5V6H15" />
      <path d="M6.2 15.3v-4h1.1a1.2 1.2 0 1 1 0 2.4H6.2m3.4 1.6v-4h1a1.4 1.4 0 0 1 0 4h-1Zm4-4v4m0-2.2h1.6" />
    </svg>
  );
}

export function IconPackage({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="m10 2.5 6.8 3.4v8.2L10 17.5l-6.8-3.4V5.9L10 2.5Z" />
      <path d="M3.2 5.9 10 9.3l6.8-3.4M10 9.3v8.2" />
    </svg>
  );
}

export function IconOther({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="3" y="3" width="14" height="14" rx="2.5" />
    </svg>
  );
}

export function IconClock({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4.3l3 2" />
    </svg>
  );
}

export function IconEye({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M1.7 10S4.8 4 10 4s8.3 6 8.3 6-3.1 6-8.3 6-8.3-6-8.3-6Z" />
      <circle cx="10" cy="10" r="2.4" />
    </svg>
  );
}

export function IconEyeOff({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M3.3 3.3l13.4 13.4" />
      <path d="M8.4 4.4C8.9 4.2 9.4 4 10 4c5.2 0 8.3 6 8.3 6a14.6 14.6 0 0 1-2.9 3.7M5.9 5.9C3.3 7.5 1.7 10 1.7 10s3.1 6 8.3 6c1 0 1.9-.2 2.7-.6" />
      <path d="M8.3 8.3a2.4 2.4 0 0 0 3.4 3.4" />
    </svg>
  );
}

export function IconX({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  );
}

export function IconSun({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <circle cx="10" cy="10" r="3.6" />
      <path d="M10 2.3v2M10 15.7v2M17.7 10h-2M4.3 10h-2M15.4 4.6l-1.4 1.4M6 14l-1.4 1.4M15.4 15.4 14 14M6 6 4.6 4.6" />
    </svg>
  );
}

export function IconCopyStack({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.3" />
      <path d="M13.5 6.5V4a1.3 1.3 0 0 0-1.3-1.3H4a1.3 1.3 0 0 0-1.3 1.3v8.2A1.3 1.3 0 0 0 4 13.5h2.5" />
    </svg>
  );
}

export function IconMoon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M17 12.3A7.3 7.3 0 0 1 7.7 3a7.3 7.3 0 1 0 9.3 9.3Z" />
    </svg>
  );
}

export function IconTrash({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M4 6h12M8 6V4.3A1.3 1.3 0 0 1 9.3 3h1.4A1.3 1.3 0 0 1 12 4.3V6" />
      <path d="M5.3 6 6 16a1.5 1.5 0 0 0 1.5 1.4h5A1.5 1.5 0 0 0 14 16l.7-10" />
      <path d="M8.3 9.2v4.6M11.7 9.2v4.6" />
    </svg>
  );
}

export function IconWarning({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M10 3.2 17.8 16.5a1 1 0 0 1-.86 1.5H3.06a1 1 0 0 1-.86-1.5L10 3.2Z" />
      <path d="M10 8.3v3.6" />
      <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconLock({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="4.5" y="9" width="11" height="8" rx="1.4" />
      <path d="M6.5 9V6.8a3.5 3.5 0 0 1 7 0V9" />
      <circle cx="10" cy="12.8" r="1" fill="currentColor" stroke="none" />
      <path d="M10 13.8v1.6" />
    </svg>
  );
}

export function IconLockOpen({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="4.5" y="9" width="11" height="8" rx="1.4" />
      <path d="M6.5 9V6.8a3.5 3.5 0 0 1 6.6-1.6" />
      <circle cx="10" cy="12.8" r="1" fill="currentColor" stroke="none" />
      <path d="M10 13.8v1.6" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M4 10a6 6 0 0 1 10.2-4.2L16 7.6" />
      <path d="M16 4v3.6h-3.6" />
      <path d="M16 10a6 6 0 0 1-10.2 4.2L4 12.4" />
      <path d="M4 16v-3.6h3.6" />
    </svg>
  );
}

export function IconRestore({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M4.5 9a5.5 5.5 0 1 1 1.6 4" />
      <path d="M4 5v4h4" />
    </svg>
  );
}

export function IconTimeline({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M5.5 3v14" />
      <circle cx="5.5" cy="5.5" r="1.3" />
      <circle cx="5.5" cy="10" r="1.3" />
      <circle cx="5.5" cy="14.5" r="1.3" />
      <path d="M9.5 5.5h6M9.5 10h4.5M9.5 14.5h6" />
    </svg>
  );
}

export function IconSettings({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M16.2 12.4a1.4 1.4 0 0 0 .28 1.54l.05.05a1.7 1.7 0 1 1-2.4 2.4l-.05-.05a1.4 1.4 0 0 0-1.54-.28 1.4 1.4 0 0 0-.85 1.28V17.5a1.7 1.7 0 1 1-3.4 0v-.08a1.4 1.4 0 0 0-.92-1.28 1.4 1.4 0 0 0-1.54.28l-.05.05a1.7 1.7 0 1 1-2.4-2.4l.05-.05a1.4 1.4 0 0 0 .28-1.54 1.4 1.4 0 0 0-1.28-.85H2.5a1.7 1.7 0 1 1 0-3.4h.08a1.4 1.4 0 0 0 1.28-.92 1.4 1.4 0 0 0-.28-1.54l-.05-.05a1.7 1.7 0 1 1 2.4-2.4l.05.05a1.4 1.4 0 0 0 1.54.28h.07a1.4 1.4 0 0 0 .85-1.28V2.5a1.7 1.7 0 1 1 3.4 0v.08a1.4 1.4 0 0 0 .85 1.28 1.4 1.4 0 0 0 1.54-.28l.05-.05a1.7 1.7 0 1 1 2.4 2.4l-.05.05a1.4 1.4 0 0 0-.28 1.54v.07a1.4 1.4 0 0 0 1.28.85h.14a1.7 1.7 0 1 1 0 3.4h-.08a1.4 1.4 0 0 0-1.28.85z" />
    </svg>
  );
}

export function IconArrowRight({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M4 10h12" />
      <path d="m11 5 5 5-5 5" />
    </svg>
  );
}

export function IconCheck({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

export function IconSort({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M6 3.5v13" />
      <path d="m3 13.5 3 3 3-3" />
      <path d="M14 16.5v-13" />
      <path d="m11 6.5 3-3 3 3" />
    </svg>
  );
}

export function IconSidePanel({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M12 4v12" />
    </svg>
  );
}

export function IconExternal({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M11 4h5v5" />
      <path d="m16 4-7 7" />
      <path d="M14 12v4H4V6h4" />
    </svg>
  );
}

export function IconRename({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M3.5 16.5h3L16 7l-3-3-9.5 9.5z" />
      <path d="m11 6 3 3" />
    </svg>
  );
}

export function IconPlus({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} {...base}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

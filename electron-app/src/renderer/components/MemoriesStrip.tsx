import React from "react";
import type { MemoryCard, MemorySample } from "../types";
import type { GridItem } from "../gridItem";
import { ImageTile } from "./FileGrid";
import { IconX, IconPlay, IconPdf, IconFile, IconClock } from "./Icons";

function sampleItem(s: MemorySample): GridItem {
  return { path: s.path, name: s.filename, isDirectory: false, kind: "image" };
}

function SampleThumb({ s }: { s: MemorySample }) {
  let inner: React.ReactNode;
  if (s.kind === "image") inner = <ImageTile item={sampleItem(s)} />;
  else if (s.kind === "video") inner = <IconPlay size={18} />;
  else if (s.filename.toLowerCase().endsWith(".pdf")) inner = <IconPdf size={18} />;
  else inner = <IconFile size={18} />;
  return (
    <span className="memory-thumb" title={s.filename}>
      {inner}
    </span>
  );
}

/** A small, calm row of resurfacing cards ("Nothing here has changed in 2
 *  years", "On this day"). Every card can be waved away with "Not now", and
 *  the whole thing can be switched off - it should feel like an occasional
 *  nudge, never a feed. */
export function MemoriesStrip({
  cards,
  onOpenFolder,
  onSeeInTimeline,
  onDismiss,
  onTurnOff,
}: {
  cards: MemoryCard[];
  onOpenFolder: (folder: string, cardId: string) => void;
  onSeeInTimeline: (date: number) => void;
  onDismiss: (cardId: string) => void;
  onTurnOff: () => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="memories-strip" aria-label="Memories">
      <div className="memories-head">
        <span className="memories-title">
          <IconClock size={13} className="sidebar-heading-icon" />
          Memories
        </span>
        <button type="button" className="memories-off" onClick={onTurnOff}>
          Turn off memories
        </button>
      </div>
      <div className="memories-cards">
        {cards.map((c) => (
          <article key={c.id} className="memory-card">
            <button
              type="button"
              className="memory-dismiss"
              title="Not now"
              aria-label="Not now"
              onClick={() => onDismiss(c.id)}
            >
              <IconX size={12} />
            </button>
            <div className="memory-thumbs">
              {c.sample.map((s) => (
                <SampleThumb key={s.path} s={s} />
              ))}
            </div>
            <div className="memory-title" title={c.folder ?? undefined}>
              {c.title}
            </div>
            <div className="memory-subtitle">{c.subtitle}</div>
            <div className="memory-detail">{c.detail}</div>
            {c.type === "stale_folder" && c.folder ? (
              <button type="button" className="memory-action" onClick={() => onOpenFolder(c.folder!, c.id)}>
                Open folder
              </button>
            ) : (
              <button type="button" className="memory-action" onClick={() => onSeeInTimeline(c.date)}>
                See in Timeline
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

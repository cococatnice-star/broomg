import { useEffect, useMemo, useRef, useState } from 'react';

type LyricLine = {
  time: number;
  text: string;
};

type LyricsPanelProps = {
  currentTime: number;
  lyricsSource?: string;
  trackTitle: string;
};

type LyricsState = 'loading' | 'ready' | 'unavailable' | 'error';

function parseLrc(content: string): LyricLine[] {
  const offsetMatch = content.match(/^\[offset:([+-]?\d+)\]\s*$/im);
  const offsetSeconds = Number(offsetMatch?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];

  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const timestamps: number[] = [];
    const pattern = /\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(rawLine)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      timestamps.push(Math.max(0, minutes * 60 + seconds + fraction + offsetSeconds));
    }

    if (!timestamps.length) continue;

    const text = rawLine.replace(/\[\d+:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!text) continue;

    for (const time of timestamps) {
      lines.push({ time, text });
    }
  }

  return lines.sort((left, right) => left.time - right.time);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function LyricsPanel({ currentTime, lyricsSource, trackTitle }: LyricsPanelProps) {
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [state, setState] = useState<LyricsState>(lyricsSource ? 'loading' : 'unavailable');
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!lyricsSource) {
      setLines([]);
      setState('unavailable');
      return;
    }

    const controller = new AbortController();
    setLines([]);
    setState('loading');

    fetch(lyricsSource, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Lyrics request failed (${response.status})`);
        return response.text();
      })
      .then((text) => {
        if (controller.signal.aborted) return;
        const parsed = parseLrc(text);
        if (!parsed.length) throw new Error('No timestamped lyric lines were found');
        setLines(parsed);
        setState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });

    return () => controller.abort();
  }, [lyricsSource]);

  const activeIndex = useMemo(() => {
    let active = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].time <= currentTime) active = index;
      else break;
    }
    return active;
  }, [currentTime, lines]);

  useEffect(() => {
    const viewport = scrollRef.current;
    const activeLine = activeLineRef.current;
    if (!viewport || !activeLine || activeIndex < 0) return;

    const viewportBounds = viewport.getBoundingClientRect();
    const lineBounds = activeLine.getBoundingClientRect();
    const targetTop =
      viewport.scrollTop +
      lineBounds.top -
      viewportBounds.top -
      (viewport.clientHeight - lineBounds.height) / 2;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    viewport.scrollTo({
      top: Math.max(0, targetTop),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [activeIndex, state]);

  const statusMessage = state === 'loading'
    ? 'Loading timed lyrics…'
    : state === 'error'
      ? 'Timed lyrics could not be loaded.'
      : `No synced lyrics are available for ${trackTitle}.`;

  return (
    <section className="lyrics-panel" aria-label={`Synced lyrics for ${trackTitle}`}>
      <header className="lyrics-panel-header">
        <div className="lyrics-heading">
          <span className="lyrics-kicker">SYNCED LYRICS</span>
          <h2 className="lyrics-track-title">{trackTitle}</h2>
        </div>
        <span className={`lyrics-sync-state${state === 'ready' ? ' is-ready' : ''}`}>
          <span className="lyrics-sync-dot" />
          {state === 'ready' ? formatTime(currentTime) : 'SYNC'}
        </span>
      </header>

      {state === 'ready' ? (
        <div className="lyrics-scroll" ref={scrollRef} aria-label="Lyrics">
          {lines.map((line, index) => (
            <p
              key={`${line.time}-${index}`}
              ref={index === activeIndex ? activeLineRef : undefined}
              className={`lyrics-line${index === activeIndex ? ' is-active' : ''}`}
              aria-current={index === activeIndex ? 'true' : undefined}
            >
              {line.text}
            </p>
          ))}
        </div>
      ) : (
        <div className="lyrics-empty" role="status">
          <span className="lyrics-empty-label">
            {state === 'error' ? 'LYRICS OFFLINE' : state === 'loading' ? 'LOADING' : 'NO LYRICS'}
          </span>
          <p>{statusMessage}</p>
        </div>
      )}
    </section>
  );
}

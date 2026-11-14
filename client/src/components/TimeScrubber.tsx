// Incident time scrubber (plan §9.3): a range over the recording with alert markers, play/pause,
// 1× / 4× / 16× and Go Live. The thumb and the time label follow the clock imperatively from the replay
// loop (`ScrubberHandle.update`), so playback does not re-render React sixty times a second.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Pause, Play, Radio, RotateCcw } from 'lucide-react';
import type { AlertDTO } from '@epicenter/shared';
import { useClock } from '../data/hooks';
import { clockTime, duration } from '../lib/format';

export interface ScrubberHandle {
  /** Moves the thumb and label to `t` (ignored while the user is dragging). */
  update(t: number): void;
}

export interface TimeScrubberProps {
  from: number;
  to: number;
  /** Incident start, for the "+1 m 20 s" label. */
  startedAt: number;
  alerts: AlertDTO[];
  /** False while the recording loads. */
  ready: boolean;
  /** True when the incident is still open, so there is a live state to go back to. */
  canGoLive: boolean;
  onSeek(t: number): void;
  onPlay(): void;
  onPause(): void;
  onSpeed(speed: number): void;
  onGoLive(): void;
  onRestart(): void;
}

const SPEEDS = [1, 4, 16];

export const TimeScrubber = forwardRef<ScrubberHandle, TimeScrubberProps>(function TimeScrubber(p, ref) {
  const { mode, speed, playing } = useClock();
  const input = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const offset = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const span = Math.max(1000, p.to - p.from);

  const paint = (t: number) => {
    if (label.current) label.current.textContent = clockTime(t);
    if (offset.current) {
      const d = t - p.startedAt;
      offset.current.textContent = `${d < 0 ? '−' : '+'}${duration(Math.abs(d))} from the first alert`;
    }
  };

  useImperativeHandle(ref, () => ({
    update(t) {
      if (dragging.current) return;
      if (input.current) input.current.value = String(t);
      paint(t);
    },
  }));

  const replay = mode === 'replay';
  // Live sits at the right-hand end of the track.
  useEffect(() => {
    if (!replay && input.current) input.current.value = String(p.to);
  }, [replay, p.to]);
  const button = 'btn';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {replay && playing ? (
          <button type="button" className={button} onClick={p.onPause} disabled={!p.ready}>
            <Pause aria-hidden className="size-4" />
            Pause
          </button>
        ) : (
          <button type="button" className={button} onClick={p.onPlay} disabled={!p.ready}>
            <Play aria-hidden className="size-4" />
            {replay ? 'Play' : 'Replay'}
          </button>
        )}
        <button type="button" className={button} onClick={p.onRestart} disabled={!p.ready} title="Back to the start of the recording">
          <RotateCcw aria-hidden className="size-4" />
          <span className="sr-only sm:not-sr-only">Start</span>
        </button>
        <div role="radiogroup" aria-label="Playback speed" className="segmented flex rounded-md border border-line p-0.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={speed === s}
              onClick={() => p.onSpeed(s)}
              className="segment metric px-2.5 py-1 text-sm"
            >
              {s}×
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <p className="text-sm" aria-live="off">
            {replay ? (
              <>
                <span ref={label} className="metric text-fg" />
                <span ref={offset} className="ml-2 hidden text-xs text-muted sm:inline" />
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-ok">
                <Radio aria-hidden className="size-4" />
                Live
              </span>
            )}
          </p>
          {p.canGoLive && (
            <button
              type="button"
              onClick={p.onGoLive}
              disabled={!replay}
              className="btn-primary disabled:bg-raised disabled:text-muted"
            >
              Go Live
            </button>
          )}
        </div>
      </div>

      <div className="relative pt-3">
        {/* Alert onsets above the track; the timeline lists the same events as text. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-[7px] top-0 h-3">
          {p.alerts.map((a) => {
            const x = (a.startedAt - p.from) / span;
            if (x < 0 || x > 1) return null;
            return (
              <span
                key={a.id}
                className={`absolute top-0 h-3 w-0.5 -translate-x-1/2 rounded-full ${a.severity === 'crit' ? 'bg-crit' : 'bg-warn'}`}
                style={{ left: `${x * 100}%` }}
              />
            );
          })}
        </div>
        <input
          ref={input}
          type="range"
          min={p.from}
          max={p.to}
          step={1000}
          defaultValue={p.from}
          disabled={!p.ready}
          aria-label="Replay position"
          aria-valuetext={replay ? undefined : 'Live'}
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
          onInput={(e) => {
            const t = Number(e.currentTarget.value);
            paint(t);
            p.onSeek(t);
          }}
          className="replay-range w-full"
        />
        <div className="mt-1 flex justify-between text-xs text-muted">
          <span className="metric">{clockTime(p.from)}</span>
          <span className="metric">{clockTime(p.to)}</span>
        </div>
      </div>
    </div>
  );
});

import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { RailsVoiceMemo } from "@t3tools/client-runtime/rails-voice";
import {
  ChevronDownIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { use, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { AudioPreviewUnmountContext } from "../files/AudioPreview";
import { useAudioPeaks } from "../files/audioPeaks";

const BARS = 40;

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function VoiceMemoMessage(props: {
  readonly voice: RailsVoiceMemo;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly time: string;
  readonly onOpen: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const onUnmount = use(AudioPreviewUnmountContext);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(props.voice.seconds);
  const [elapsed, setElapsed] = useState(0);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const asset = useAssetUrlState(
    visible ? props.environmentId : null,
    visible ? props.resource : null,
  );
  const src = asset._tag === "Success" ? asset.url : undefined;
  const unavailable = failed || asset._tag === "Failure";
  const peaks = useAudioPeaks(src, BARS);
  const audioRef = useStableCallback((element: HTMLAudioElement | null) => {
    audio.current = element;
    if (element)
      return () => {
        element.pause();
        onUnmount?.(element);
        audio.current = null;
      };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- IntersectionObserver defers loading the audio until the memo scrolls into view
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const loading = !unavailable && (!src || !ready);
  const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;
  const togglePlay = () => {
    if (unavailable) {
      props.onOpen();
      return;
    }
    const element = audio.current;
    if (!element) return;
    if (!element.paused) element.pause();
    else
      void element.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
  };
  const seekTo = (seconds: number) => {
    const element = audio.current;
    if (!element || duration <= 0) return;
    element.currentTime = Math.min(duration, Math.max(0, seconds));
    setElapsed(element.currentTime);
  };
  const seekPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === "pointermove" && event.buttons !== 1) return;
    const box = event.currentTarget.getBoundingClientRect();
    seekTo(((event.clientX - box.left) / box.width) * duration);
  };
  const seekKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, Home: -duration, End: duration }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    seekTo(event.key === "Home" ? 0 : event.key === "End" ? duration : elapsed + step);
  };
  const Icon = unavailable
    ? TriangleAlertIcon
    : loading
      ? LoaderCircleIcon
      : playing
        ? PauseIcon
        : PlayIcon;
  const action = unavailable ? "Open" : loading ? "Loading" : playing ? "Pause" : "Play";

  return (
    <div
      ref={container}
      data-voice-memo="true"
      className="flex w-80 max-w-full flex-col gap-1.5 rounded-2xl bg-message px-2.5 pt-2.5 pb-2 text-message-foreground"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`${action} voice memo, ${clock(duration)}`}
          disabled={loading && !unavailable}
          onClick={togglePlay}
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:scale-95 disabled:cursor-default"
        >
          <Icon
            aria-hidden
            className={cn(
              "size-4",
              loading && "animate-spin",
              !loading && !playing && !unavailable && "translate-x-px fill-current",
              playing && "fill-current",
            )}
          />
        </button>
        <div
          role="slider"
          tabIndex={unavailable ? -1 : 0}
          aria-label="Voice memo position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(elapsed)}
          aria-valuetext={`${clock(elapsed)} of ${clock(duration)}`}
          onPointerDown={seekPointer}
          onPointerMove={seekPointer}
          onKeyDown={seekKey}
          className="flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center justify-between gap-px rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {Array.from({ length: BARS }, (_, bar) => (
            <span
              key={bar}
              aria-hidden
              className={cn(
                "w-0.5 shrink-0 rounded-full transition-colors duration-100",
                (bar + 0.5) / BARS <= progress ? "bg-foreground" : "bg-muted-foreground/45",
              )}
              style={{ height: `${Math.round(18 + (peaks?.[bar] ?? 0.12) * 82)}%` }}
            />
          ))}
        </div>
        <span dir="ltr" className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {unavailable ? "Unavailable" : clock(playing || elapsed > 0 ? elapsed : duration)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 ps-12 text-xs text-muted-foreground">
        {props.voice.transcript ? (
          <button
            type="button"
            aria-expanded={transcriptOpen}
            onClick={() => setTranscriptOpen((open) => !open)}
            className="-ms-1 flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {transcriptOpen ? "Hide transcript" : "Transcript"}
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", transcriptOpen && "rotate-180")}
            />
          </button>
        ) : (
          <span />
        )}
        <span className="tabular-nums">{props.time}</span>
      </div>
      {transcriptOpen ? (
        <p
          data-thread-find-text="true"
          className="ps-12 pe-1 pb-1 text-sm leading-relaxed break-words whitespace-pre-wrap"
        >
          {props.voice.transcript}
        </p>
      ) : null}
      {src && !failed ? (
        <audio
          ref={audioRef}
          hidden
          preload="metadata"
          src={src}
          aria-label={props.name}
          onLoadedMetadata={(event) => {
            setReady(true);
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) setDuration(value);
          }}
          onCanPlay={() => setReady(true)}
          onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={(event) => {
            setPlaying(false);
            event.currentTarget.currentTime = 0;
            setElapsed(0);
          }}
          onError={() => {
            setPlaying(false);
            setFailed(true);
          }}
        />
      ) : null}
    </div>
  );
}

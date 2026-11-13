import { useEffect, useState } from "react";

const peaksBySource = new Map<string, Promise<ReadonlyArray<number>>>();

function bucketPeaks(samples: Float32Array, bars: number): ReadonlyArray<number> {
  const size = Math.max(1, Math.floor(samples.length / bars));
  const levels = Array.from({ length: bars }, (_, bar) => {
    let sum = 0;
    const start = bar * size;
    const end = Math.min(samples.length, start + size);
    for (let index = start; index < end; index += 1) sum += samples[index]! * samples[index]!;
    return Math.sqrt(sum / Math.max(1, end - start));
  });
  const loudest = Math.max(...levels, 1e-4);
  return levels.map((level) => Math.min(1, level / loudest));
}

async function decodePeaks(src: string, bars: number): Promise<ReadonlyArray<number>> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, 44100);
  const audio = await context.decodeAudioData(buffer);
  return bucketPeaks(audio.getChannelData(0), bars);
}

export function useAudioPeaks(src: string | undefined, bars: number): ReadonlyArray<number> | null {
  const [peaks, setPeaks] = useState<{ src: string; levels: ReadonlyArray<number> } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- decoding the audio file is async work outside React
  useEffect(() => {
    if (!src || typeof OfflineAudioContext === "undefined") return;
    const key = `${bars}:${src}`;
    let pending = peaksBySource.get(key);
    if (!pending) {
      pending = decodePeaks(src, bars);
      peaksBySource.set(key, pending);
      pending.catch(() => peaksBySource.delete(key));
    }
    let live = true;
    pending.then(
      (levels) => {
        if (live) setPeaks({ src, levels });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [src, bars]);
  return peaks !== null && peaks.src === src ? peaks.levels : null;
}

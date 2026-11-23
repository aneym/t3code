import type { EmbedRouteTimings } from "@t3tools/contracts";

type Step = "navigate" | "mounted" | "drawn";

let route: {
  readonly thread: string;
  readonly at: number;
  marks: Partial<Record<Step, number>>;
} | null = null;

const since = (at: number) => Math.round((performance.now() - at) * 10) / 10;

export function startEmbedRouteTimings(thread: string): void {
  route = { thread, at: performance.now(), marks: {} };
}

let loadStarted = false;

export function startEmbedLoadTimings(thread: string): void {
  if (loadStarted) return;
  loadStarted = true;
  if (route !== null) return;
  route = { thread, at: 0, marks: {} };
  markEmbedRouteStep(thread, "navigate");
}

export function markEmbedRouteStep(thread: string, step: Step): void {
  if (route === null || route.thread !== thread || route.marks[step] !== undefined) return;
  route.marks[step] = since(route.at);
}

export function takeEmbedRouteTimings(thread: string): EmbedRouteTimings | undefined {
  if (route === null || route.thread !== thread) return undefined;
  const { at, marks } = route;
  route = null;
  const ready = since(at);
  const drawn = marks.drawn ?? ready;
  const mounted = marks.mounted ?? drawn;
  return { navigate: marks.navigate ?? mounted, mounted, drawn, ready };
}

import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const DEFAULT_MIN_CHILD_SPAN_MS = 10;

const minChildSpanMs = Config.Number("T3CODE_TRACE_MIN_CHILD_SPAN_MS").pipe(
  Config.withDefault(DEFAULT_MIN_CHILD_SPAN_MS),
);

const keepsRecord = (record: TraceRecord, minMs: number) =>
  record.type !== "effect-span" ||
  record.parentSpanId === undefined ||
  record.exit._tag !== "Success" ||
  record.durationMs >= minMs;

export const sampledServerSink = Effect.fn("TraceSampling.sampledServerSink")(function* (
  sink: TraceSink,
) {
  const minMs = yield* minChildSpanMs.pipe(Effect.orElseSucceed(() => DEFAULT_MIN_CHILD_SPAN_MS));
  if (minMs <= 0) return sink;
  return {
    ...sink,
    push: (record: TraceRecord) => {
      if (keepsRecord(record, minMs)) sink.push(record);
    },
  } satisfies TraceSink;
});

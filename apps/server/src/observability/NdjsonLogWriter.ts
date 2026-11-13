import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";

export type NdjsonFields = Record<string, unknown>;

const MAX_BUFFER_BYTES = 1024 * 1024;
const FLUSH_EVERY = "1 second";

export const makeNdjsonLogWriter = Effect.fnUntraced(function* (options: {
  readonly filePath: string;
  readonly maxBytes: number;
}) {
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: 2,
  });
  let buffer: Array<string> = [];
  let bufferBytes = 0;
  let dropped = 0;
  const flush = Effect.suspend(() => {
    if (dropped > 0) {
      buffer.push(`{"k":"dropped","n":${dropped}}\n`);
      dropped = 0;
    }
    if (buffer.length === 0) return Effect.void;
    const chunk = buffer.join("");
    buffer = [];
    bufferBytes = 0;
    return sink.write(chunk).pipe(Effect.ignore);
  });
  const pending = yield* Latch.make(false);
  yield* pending.await.pipe(
    Effect.andThen(Effect.sleep(FLUSH_EVERY)),
    Effect.andThen(Effect.sync(() => pending.closeUnsafe())),
    Effect.andThen(flush),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => flush);
  return (fields: NdjsonFields) => {
    const line = `${JSON.stringify({ t: DateTime.formatIso(DateTime.nowUnsafe()), ...fields })}\n`;
    pending.openUnsafe();
    if (bufferBytes + line.length > MAX_BUFFER_BYTES) {
      dropped += 1;
      return;
    }
    buffer.push(line);
    bufferBytes += line.length;
  };
});

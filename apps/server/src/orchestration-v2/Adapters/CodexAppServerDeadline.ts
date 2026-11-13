import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Session setup and turn/start answer promptly; silence this long means a wedged app-server.
const CODEX_APP_SERVER_REQUEST_DEADLINE = "2 minutes";

export class CodexAppServerUnresponsiveError extends Schema.TaggedError<CodexAppServerUnresponsiveError>()(
  "CodexAppServerUnresponsiveError",
  { method: Schema.String },
) {
  override get message() {
    return `Codex app-server did not answer ${this.method} within ${CODEX_APP_SERVER_REQUEST_DEADLINE}.`;
  }
}

// The outcome of an unanswered request is unknown, so it fails rather than retries.
export const codexAppServerDeadline =
  (retire: (error: CodexAppServerUnresponsiveError) => Effect.Effect<unknown>) =>
  (method: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: CODEX_APP_SERVER_REQUEST_DEADLINE,
        orElse: () => {
          const error = new CodexAppServerUnresponsiveError({ method });
          return retire(error).pipe(Effect.andThen(Effect.fail(error)));
        },
      }),
    );

import * as Schema from "effect/Schema";
import { SecretRef, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestratorMcpClientRequestId } from "./orchestratorMcp.ts";
import { secretRequestPageUrl } from "./secretRequest.ts";

// Not trimmed: whitespace in a password matters. The check stays out of the advertised schema.
const PastedSecretValue = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0, { expected: "a non-empty string" }),
);

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "Card title, such as 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "What it is for and where to get it. A link goes in `url`.",
  }),
  url: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.makeFilter((value) => secretRequestPageUrl(value) !== null, {
        expected: "an http(s) URL",
      }),
    ),
  ).annotate({
    description: "Sign-in or setup page for the value. Shown as a button.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString),
  delivery: Schema.optional(Schema.Literals(["secretRef", "file"])).annotate({
    description: "secretRef (default) for a T3 tool; file for a command.",
  }),
  value: Schema.optional(PastedSecretValue).annotate({
    description: "Pasted in this thread; no card.",
  }),
  /** Default 10 minutes. */
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description:
      "Retry key for this ask. Reuse it after restarting. New key after a timeout or cancel.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("restarting").annotate({
      description:
        "T3 Code is restarting. Retry request_secret now with the same clientRequestId; keep this turn alive, do not end with chat text.",
    }),
    clientRequestId: OrchestratorMcpClientRequestId.annotate({
      description:
        "Call request_secret again with this clientRequestId to keep waiting for the same answer.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("saved"),
    secretRef: SecretRef.annotate({
      description: "One-use. Pass to a tool that accepts a secretRef. You never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "file holds the value." }),
    file: Schema.String.annotate({
      description:
        "Owner-only file with the value. Read it inside commands and never print it. Deleted after 24 hours.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: user chose not to; don't ask again. cancelled: ended with the run. timed_out: no answer in time. After cancelled or timed_out, ask again with a new `clientRequestId` only if still needed.",
    }),
    note: Schema.optional(Schema.String).annotate({ description: "What to do next." }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

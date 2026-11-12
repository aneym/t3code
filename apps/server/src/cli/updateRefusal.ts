import { cliReleaseChannelOf, type CliReleaseChannel } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { cliRefusal } from "../cliRefusal.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateRefusal } from "../policy/managedUpdates.ts";

export class UpdateRefusedError extends Schema.TaggedError<UpdateRefusedError>()(
  "UpdateRefusedError",
  { reason: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return this.reason;
  }
}

export const refuseUpdate = Effect.fn("cli.update.refuse")(function* (input: {
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
}) {
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const refusal = managedUpdateRefusal(
    policy.document,
    input.requestedVersion === undefined
      ? (input.channel ?? cliReleaseChannelOf(packageJson.version))
      : cliReleaseChannelOf(input.requestedVersion),
  );
  if (refusal !== undefined) return yield* new UpdateRefusedError({ reason: refusal });
});

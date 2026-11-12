import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { cliRefusal } from "./cliRefusal.ts";
import { associatedBundleIdsProblem } from "./cloud/bootServiceAssociation.ts";
import { bootServiceNameProblem } from "./cloud/bootServiceRender.ts";
import { selfUpdateSwitch } from "./cloud/selfUpdateSwitch.ts";
import { onOffSwitchRefusal } from "./onOffSwitch.ts";
import { providerAllowlistProblem } from "./provider/providerAllowlist.ts";
import { startupPairingSwitch } from "./startupPairingSwitch.ts";

export class EnvironmentValueError extends Schema.TaggedError<EnvironmentValueError>()(
  "EnvironmentValueError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return this.detail;
  }
}

export const requireValidEnvironmentValues = Effect.gen(function* () {
  const providers = yield* Config.String("T3CODE_PROVIDERS").pipe(Config.option);
  const problem =
    onOffSwitchRefusal(startupPairingSwitch) ??
    onOffSwitchRefusal(selfUpdateSwitch) ??
    bootServiceNameProblem ??
    associatedBundleIdsProblem ??
    Option.match(providers, { onNone: () => undefined, onSome: providerAllowlistProblem });
  if (problem !== undefined) return yield* new EnvironmentValueError({ detail: problem });
});

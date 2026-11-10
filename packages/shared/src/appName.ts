import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import * as HostProcess from "./HostProcess.ts";

const APP_NAME_VARIABLE = "T3CODE_APP_NAME";
const DEFAULT_APP_NAME = "T3 Code";
const MAX_APP_NAME_LENGTH = 64;

const configuredAppName = Config.String(APP_NAME_VARIABLE).pipe(
  Config.withDefault(DEFAULT_APP_NAME),
);

const usableAppName = (value: string): string | null => {
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_APP_NAME_LENGTH ? name : null;
};

export const appName: Effect.Effect<string> = configuredAppName.pipe(
  Effect.map((value) => usableAppName(value) ?? DEFAULT_APP_NAME),
  Effect.orElseSucceed(() => DEFAULT_APP_NAME),
);

export const appNameRefusal = Effect.gen(function* () {
  const value = (yield* HostProcess.Environment)[APP_NAME_VARIABLE];
  return value === undefined || usableAppName(value) !== null
    ? null
    : `${APP_NAME_VARIABLE} must be 1 to ${MAX_APP_NAME_LENGTH} characters and not only spaces.`;
});

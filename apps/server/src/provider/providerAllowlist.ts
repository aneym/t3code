import type {
  ProviderDriverKind,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

export type ProviderAllowlist = ReadonlySet<ProviderDriverKind> | undefined;

const nameKey = (name: string) => name.trim().toLowerCase();

const DRIVERS_BY_NAME: ReadonlyMap<string, ProviderDriverKind> = new Map(
  BUILT_IN_DRIVERS.flatMap((driver) => [
    [nameKey(driver.driverKind), driver.driverKind] as const,
    [nameKey(driver.metadata.displayName), driver.driverKind] as const,
  ]),
);

type ParsedAllowlist =
  | { readonly drivers: ReadonlySet<ProviderDriverKind> }
  | { readonly problem: string };

const parseAllowlist = (value: string): ParsedAllowlist => {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return { problem: "T3CODE_PROVIDERS names no provider. Unset it to allow every provider." };
  }
  const drivers = new Set<ProviderDriverKind>();
  for (const name of names) {
    const driver = DRIVERS_BY_NAME.get(nameKey(name));
    if (driver === undefined) {
      const known = BUILT_IN_DRIVERS.map((entry) => entry.driverKind).join(", ");
      return {
        problem: `T3CODE_PROVIDERS names "${name}", which is not a provider. Known: ${known}.`,
      };
    }
    drivers.add(driver);
  }
  return { drivers };
};

export const providerAllowlistProblem = (value: string): string | undefined => {
  const parsed = parseAllowlist(value);
  return "problem" in parsed ? parsed.problem : undefined;
};

export const providerAllowlistConfig: Config.Config<ProviderAllowlist> = Config.String(
  "T3CODE_PROVIDERS",
).pipe(
  Config.mapEffect((value) => {
    const parsed = parseAllowlist(value);
    return "problem" in parsed
      ? Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: parsed.problem })),
          ),
        )
      : Effect.succeed(parsed.drivers);
  }),
  Config.option,
  Config.map(Option.getOrUndefined),
);

export const limitConfigMap = (
  configMap: ProviderInstanceConfigMap,
  allowlist: ProviderAllowlist,
  alwaysKept: (instanceId: ProviderInstanceId) => boolean,
): ProviderInstanceConfigMap =>
  allowlist === undefined
    ? configMap
    : (Object.fromEntries(
        Object.entries(configMap).filter(
          ([instanceId, entry]) =>
            allowlist.has(entry.driver) || alwaysKept(instanceId as ProviderInstanceId),
        ),
      ) as ProviderInstanceConfigMap);

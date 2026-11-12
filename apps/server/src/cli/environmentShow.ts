import { AgentPlacementScore, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { formatPlacementScore } from "./threadPlacement.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  printJson,
  reportCliErrors,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";

const EnvironmentIdentity = Schema.Struct({
  environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
  serverVersion: ExecutionEnvironmentDescriptor.fields.serverVersion,
  label: ExecutionEnvironmentDescriptor.fields.label,
  platform: ExecutionEnvironmentDescriptor.fields.platform,
  placementHealth: Schema.optionalKey(AgentPlacementScore),
});

const reportEnvironmentErrors = reportCliErrors(
  Schema.is(
    Schema.Union([McpServerNotRunningError, McpServerUnreachableError, McpToolFailedError]),
  ),
);

export const environmentShowCommand = Command.make("show", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show the running local server's environment identity."),
  Command.withHandler((flags) =>
    withOwnerMcpTools("environment show", flags, (tools) =>
      Effect.gen(function* () {
        const descriptor = yield* tools.call("t3_environment_read", {}, EnvironmentIdentity);
        yield* flags.json
          ? printJson(descriptor)
          : Console.log(
              [
                descriptor.label,
                `  environmentId: ${descriptor.environmentId}`,
                `  serverVersion: ${descriptor.serverVersion}`,
                ...(descriptor.placementHealth === undefined
                  ? []
                  : [`placement:\n${formatPlacementScore(descriptor.placementHealth)}`]),
              ].join("\n"),
            );
      }),
    ).pipe(reportEnvironmentErrors),
  ),
);

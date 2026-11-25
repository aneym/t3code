import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelection, ProviderOptionSelectionValue } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Provider instance id from `orchestrator_capabilities`.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Prefer `providerInstanceId`.",
    }),
  ),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description:
        "Options from `orchestrator_capabilities`, such as {effort:'max'}. Given values override inherited. [] or {} clears.",
    }),
  ),
  environmentId: Schema.optional(
    EnvironmentId.annotate({
      description:
        "Linked environment to run in. Provider and model default to yours; others come from `orchestrator_capabilities` with this `environmentId`.",
    }),
  ),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Project whose repository the work belongs to; with no `environmentId`, placement may run it on a linked machine's project with the same repository. Default: this thread's.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Run on any machine with this repository: `repositoryIdentity.canonicalKey` from `t3_project_list`. Not with `projectId`.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpAllowedEnvironments = Schema.Array(EnvironmentId).annotate({
  description:
    "Machines this start may use, at least one; others are skipped and an `environmentId` outside them is refused. List this machine to let the start stay here. Omitted: any machine.",
});

import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpTaskRole,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { withLegacyUltracodeEffort } from "@t3tools/shared/model";
import { invalidOptionSelections, knownOptions } from "./optionSelections.ts";

export type DelegatedChildModelSetting = ServerSettings["delegatedChildModel"];

type Options = ReadonlyArray<ProviderOptionSelection>;
type Selection = Pick<ModelSelection, "instanceId" | "model">;

export function delegatedChildDefaultModel(
  setting: DelegatedChildModelSetting,
  instanceId: ModelSelection["instanceId"],
  parent: ModelSelection,
): string | undefined {
  if (setting !== null && setting.providerInstanceId === instanceId) return setting.model;
  return instanceId === parent.instanceId ? parent.model : undefined;
}

function defaultOptions(
  setting: DelegatedChildModelSetting,
  selection: Selection,
  descriptors?: ReadonlyArray<ProviderOptionDescriptor>,
): Options | undefined {
  if (
    setting === null ||
    setting.providerInstanceId !== selection.instanceId ||
    setting.model !== selection.model
  )
    return undefined;
  const options = knownOptions(
    withLegacyUltracodeEffort(descriptors ?? [], setting.options) ?? undefined,
    descriptors,
  );
  return options === undefined ||
    options.length === 0 ||
    invalidOptionSelections(options, descriptors).length > 0
    ? undefined
    : options;
}

function merged(base: Options, requested: Options): Options {
  const selections = new Map(base.map((selection) => [selection.id, selection]));
  for (const selection of requested) selections.set(selection.id, selection);
  return [...selections.values()];
}

export function delegatedChildOptions(input: {
  readonly setting: DelegatedChildModelSetting;
  readonly selection: Selection;
  readonly parent: ModelSelection;
  readonly requested: Options | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
}): Options | undefined {
  const { selection, parent, descriptors } = input;
  const defaults = defaultOptions(input.setting, selection, descriptors);
  const base =
    defaults ??
    (selection.instanceId === parent.instanceId && selection.model === parent.model
      ? knownOptions(
          withLegacyUltracodeEffort(descriptors ?? [], parent.options) ?? undefined,
          descriptors,
        )
      : undefined);
  if (input.requested === undefined) return base;
  return merged(input.requested.length === 0 ? (defaults ?? []) : (base ?? []), input.requested);
}

export function remoteChildOptions(
  setting: DelegatedChildModelSetting,
  selection: Selection,
  parent: ModelSelection,
  requested: Options | undefined,
): Options | undefined {
  const defaults = defaultOptions(setting, selection);
  if (defaults !== undefined) return merged(defaults, requested ?? []);
  return (
    requested ??
    (selection.instanceId === parent.instanceId && selection.model === parent.model
      ? parent.options
      : undefined)
  );
}

type GuardSettings = Pick<ServerSettings, "childModelGuard" | "childModelAllow">;

const matches = (pattern: string, model: string) =>
  pattern.endsWith("*") ? model.startsWith(pattern.slice(0, -1)) : model === pattern;

const allowsRole = (rule: GuardSettings["childModelAllow"][number], role: string) =>
  rule.roles === undefined || rule.roles.some((candidate) => candidate === role);

function childModelRefusal(
  settings: GuardSettings,
  model: string,
  requestedRole: OrchestratorMcpTaskRole | undefined,
): string | undefined {
  if (!settings.childModelGuard || settings.childModelAllow.length === 0) return undefined;
  const role = requestedRole ?? "general";
  const forRole = settings.childModelAllow.filter((rule) => allowsRole(rule, role));
  if (forRole.some((rule) => matches(rule.model, model))) return undefined;
  const elsewhere = settings.childModelAllow
    .filter((rule) => matches(rule.model, model))
    .flatMap((rule) => rule.roles ?? []);
  const allowed = forRole.map((rule) => rule.model).join(", ");
  return [
    `Child model ${model} is not allowed for role ${role}.`,
    allowed === "" ? `No model is allowed for role ${role}.` : `Use ${allowed}.`,
    elsewhere.length === 0 ? "" : `${model} is allowed only for role ${elsewhere.join(", ")}.`,
  ]
    .filter((line) => line !== "")
    .join(" ");
}

export const guardChildModel = (
  settings: GuardSettings,
  model: string,
  role: OrchestratorMcpTaskRole | undefined,
) => {
  const message = childModelRefusal(settings, model, role);
  return message === undefined
    ? Effect.void
    : Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));
};

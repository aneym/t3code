import type { ModelSelection, ServerSettings } from "@t3tools/contracts";

export type DelegatedChildModelSetting = ServerSettings["delegatedChildModel"];

export function delegatedChildDefaultModel(
  setting: DelegatedChildModelSetting,
  instanceId: ModelSelection["instanceId"],
  parent: ModelSelection,
): string | undefined {
  if (setting !== null && setting.providerInstanceId === instanceId) return setting.model;
  return instanceId === parent.instanceId ? parent.model : undefined;
}

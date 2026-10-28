import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  projectPinChanges,
  projectPinReorderChanges,
} from "@t3tools/client-runtime/state/project-pins";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export function useProjectPins(groups: readonly SidebarProjectSnapshot[]) {
  const update = useOrchestrationCommand(projectEnvironment.update);
  const editable = useEnvironmentsWithScope(
    groups.flatMap((group) => group.memberProjects),
    AuthOrchestrationOperateScope,
  );
  const canPin = (group: SidebarProjectSnapshot) =>
    group.memberProjects.every((member) => editable.has(member.environmentId));
  const apply = async (changes: { group: SidebarProjectSnapshot; pinOrder: string | null }[]) => {
    if (
      changes.some(({ group }) =>
        group.memberProjects.some(
          (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
        ),
      )
    )
      return;
    for (const { group, pinOrder } of changes) {
      for (const member of group.memberProjects) {
        const result = await update({
          environmentId: member.environmentId,
          input: { projectId: member.id, pinOrder },
        });
        if (result._tag === "Failure") return;
      }
    }
  };
  return {
    canPin,
    togglePin: (key: string) => apply(projectPinChanges(groups, key)),
    reorderPins: (activeKey: string, overKey: string) =>
      apply(projectPinReorderChanges(groups, activeKey, overKey)),
  };
}

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  projectPinChanges,
  projectPinReorderChanges,
} from "@t3tools/client-runtime/state/project-pins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export function useProjectPins(groups: readonly SidebarProjectSnapshot[]) {
  const update = useOrchestrationCommand(projectEnvironment.update, { reportFailure: false });
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
    const results = await Promise.all(
      changes.flatMap(({ group, pinOrder }) =>
        group.memberProjects.map((member) =>
          update({
            environmentId: member.environmentId,
            input: { projectId: member.id, pinOrder },
          }),
        ),
      ),
    );
    const failures = results.flatMap((result) =>
      result._tag === "Failure" && !isAtomCommandInterrupted(result) ? [result] : [],
    );
    if (failures.length === 0) return;
    const error = squashAtomCommandFailure(failures[0]!);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title:
          failures.length === 1
            ? "Failed to update project pin"
            : `Failed to update ${failures.length} project pins`,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  return {
    canPin,
    togglePin: (key: string) => apply(projectPinChanges(groups, key)),
    reorderPins: (activeKey: string, overKey: string) =>
      apply(projectPinReorderChanges(groups, activeKey, overKey)),
  };
}

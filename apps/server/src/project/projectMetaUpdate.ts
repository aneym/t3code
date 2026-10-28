import type { CommandId, ProjectId, ProjectUpdatePayload } from "@t3tools/contracts";
import type { ProjectMetaUpdateCommand } from "../orchestration-v2/ProjectCommands.ts";

export function projectMetaUpdate(
  input: ProjectUpdatePayload & { readonly commandId: CommandId; readonly projectId: ProjectId },
  workspaceRoot: string | undefined,
): ProjectMetaUpdateCommand {
  return {
    type: "project.meta.update",
    commandId: input.commandId,
    projectId: input.projectId,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(input.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: input.defaultModelSelection }),
    ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
    ...(input.pinOrder === undefined ? {} : { pinOrder: input.pinOrder }),
    ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
    ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
    ...(input.defaultThreadEnvMode === undefined
      ? {}
      : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
    ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
  };
}

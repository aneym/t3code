import type { ScheduledTask } from "@t3tools/contracts";
import { resolveProjectSettings, resolveSendEnvMode } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

type ScheduledRunTask = Pick<ScheduledTask, "projectId" | "workspaceStrategy" | "creationSource">;

export class ScheduledRunWorkspace extends Context.Service<
  ScheduledRunWorkspace,
  {
    readonly resolve: (task: ScheduledRunTask) => Effect.Effect<ScheduledTask["workspaceStrategy"]>;
  }
>()("t3/scheduledTasks/ScheduledRunWorkspace") {}

export const layer = Layer.effect(
  ScheduledRunWorkspace,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const git = yield* GitWorkflow.GitWorkflowService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const runsInPlace = Effect.fn("ScheduledRunWorkspace.runsInPlace")(function* (
      task: ScheduledRunTask,
    ) {
      const project = Option.getOrNull(yield* projects.getById(task.projectId));
      if (project === null) return false;
      if (task.creationSource === "mcp") {
        const resolved = resolveProjectSettings(
          yield* serverSettings.getSettings,
          task.projectId,
          project,
        );
        if (
          resolved.sources.defaultThreadEnvMode === "project" &&
          resolved.settings.defaultThreadEnvMode === "local"
        )
          return true;
      }
      const isGitRepo = yield* git.isRepository(project.workspaceRoot);
      return resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo }) === "local";
    });

    const resolve = Effect.fn("ScheduledRunWorkspace.resolve")(function* (task: ScheduledRunTask) {
      if (task.workspaceStrategy.type !== "worktree") return task.workspaceStrategy;
      const inPlace = yield* runsInPlace(task).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not check a scheduled run's workspace", {
            projectId: task.projectId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      return inPlace ? { type: "root" as const } : task.workspaceStrategy;
    });

    return ScheduledRunWorkspace.of({ resolve });
  }),
);

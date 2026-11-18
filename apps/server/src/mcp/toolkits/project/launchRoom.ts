import {
  type OrchestrationV2Run,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Gate from "../../../orchestration-v2/DelegatedChildStartGate.ts";
import { localProject } from "../../../peer/PlacementRoom.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import { unavailable } from "../../threadAccess.ts";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const launchProject = Effect.fn("LaunchRoom.launchProject")(function* <E, R>(
  input: {
    readonly repository?: string | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly scratch?: boolean | undefined;
  },
  fallback: Effect.Effect<ProjectId, E, R>,
) {
  if (input.repository === undefined) return yield* fallback;
  if (input.projectId !== undefined || input.scratch === true)
    return yield* refuse("Pass repository, projectId or scratch, only one.");
  const settings = yield* Settings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
  if (!current.agentPlacementByRoom)
    return yield* refuse(
      "repository needs agentPlacementByRoom on this environment; pass projectId.",
    );
  const projectId = yield* localProject(yield* Project.ProjectService, input.repository);
  if (projectId === undefined)
    return yield* refuse(
      `No single project here has repository ${input.repository}; pass projectId.`,
    );
  return projectId;
});

export const admitLaunch = Effect.fn("LaunchRoom.admitLaunch")(function* <A, E, R>(
  remoteChild: boolean,
  projectId: ProjectId,
  launch: (held: boolean) => Effect.Effect<A, E, R>,
) {
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  if (!remoteChild || Option.isNone(gate)) return yield* launch(false);
  return yield* gate.value.admit({ projectId }, launch);
});

export const launchHold = Effect.fn("LaunchRoom.launchHold")(function* (
  run: Pick<OrchestrationV2Run, "id" | "status" | "childStartHeld"> | undefined,
) {
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  if (run === undefined || run.childStartHeld !== true || Option.isNone(gate)) return {};
  const hold = yield* gate.value.hold(run.id);
  return hold === undefined ? {} : { hold };
});

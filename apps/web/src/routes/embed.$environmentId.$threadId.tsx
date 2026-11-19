import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { EmbedPage, EmbeddedThread } from "../components/embed/EmbedPage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreads } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";

function threadInMemory(params: { readonly environmentId: string; readonly threadId: string }) {
  const target = resolveThreadRouteTarget(params);
  if (target?.kind !== "server") return false;
  const { environmentId, threadId } = target.threadRef;
  const atom = environmentThreads.stateAtom(environmentId, threadId);
  if (!appAtomRegistry.getNodes().has(atom)) return false;
  const result = appAtomRegistry.get(atom);
  return AsyncResult.isSuccess(result) && Option.isSome(result.value.data);
}

function EmbedRoute() {
  const { environmentId, threadId } = Route.useParams();
  const { authGateState } = Route.useRouteContext();
  return (
    <EmbedPage
      authenticated={authGateState.status === "authenticated"}
      environmentId={environmentId}
      threadId={threadId}
    >
      <EmbeddedThread environmentId={environmentId} threadId={threadId} />
    </EmbedPage>
  );
}

export const Route = createFileRoute("/embed/$environmentId/$threadId")({
  loader: ({ params }) =>
    threadInMemory(params) ? undefined : new Promise<void>((resolve) => setTimeout(resolve, 0)),
  component: EmbedRoute,
});

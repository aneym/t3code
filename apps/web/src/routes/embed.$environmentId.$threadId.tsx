import { createFileRoute } from "@tanstack/react-router";

import { EmbedPage, EmbeddedThread } from "../components/embed/EmbedPage";

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
  loader: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  component: EmbedRoute,
});

import { createFileRoute } from "@tanstack/react-router";
import { ProviderInstanceId } from "@t3tools/contracts";

import { EmbedPage } from "../components/embed/EmbedPage";
import { EmbedProvidersView } from "../components/embed/EmbedProvidersView";

function EmbedProvidersRoute() {
  const { environmentId } = Route.useParams();
  const { thread, instanceId } = Route.useSearch();
  const { authGateState } = Route.useRouteContext();
  return (
    <EmbedPage
      authenticated={authGateState.status === "authenticated"}
      environmentId={environmentId}
      threadId={null}
    >
      <EmbedProvidersView
        environmentId={environmentId}
        returnThreadId={thread ?? null}
        instanceId={instanceId ?? null}
      />
    </EmbedPage>
  );
}

export const Route = createFileRoute("/embed/$environmentId/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.thread === "string" && raw.thread.trim() ? { thread: raw.thread } : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: EmbedProvidersRoute,
});

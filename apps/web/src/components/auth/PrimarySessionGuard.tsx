import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { fetchSessionState } from "../../environments/primary/auth";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

export function PrimarySessionGuard() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return environmentId === null ? null : <PrimarySessionWatch environmentId={environmentId} />;
}

function PrimarySessionWatch({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const refused = state.phase === "blocked" && state.lastFailure?.reason === "authentication";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads into pairing once the server stops accepting this browser's session
  useEffect(() => {
    if (!refused) return;
    let current = true;
    void fetchSessionState().then(
      (session) => {
        if (current && !session.authenticated) window.location.assign("/pair");
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [refused]);
  return null;
}

import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { forgetServerAuthSession } from "../../environments/primary";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";

const primarySessionEndedAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
  return (
    Option.isSome(state) &&
    state.value.phase === "blocked" &&
    state.value.lastFailure?.failureCause === "signed_out"
  );
}).pipe(Atom.withLabel("web-primary-session-ended"));

export function PrimarySessionEndedRedirect() {
  const router = useRouter();
  const sessionEnded = useAtomValue(primarySessionEndedAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the connection supervisor, outside React, reports the ended session
  useEffect(() => {
    if (!sessionEnded) return;
    forgetServerAuthSession();
    void router.navigate({ to: "/pair", replace: true });
  }, [router, sessionEnded]);
  return null;
}

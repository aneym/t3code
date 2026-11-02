import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { enabledEnvironmentIds, type EnvironmentCatalogState } from "./connections.ts";
import type { EnvironmentShellState } from "./shell.ts";

export function createRecoveryLabelAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  return Atom.make((get) => {
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const state = get(input.shellStateValueAtom(environmentId));
      if (
        state.status === "synchronizing" &&
        Option.exists(state.snapshot, (snapshot) => snapshot.recoveryPhase === "recovering")
      )
        return "Catching up";
    }
    return null;
  }).pipe(Atom.withLabel("environment-recovery-label"));
}

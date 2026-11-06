import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { clearThreadPreviewState, previewThreadRefsAtom } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentSession, readPreparedConnection } from "~/state/session";

import { isLocalPreviewEnvironment } from "./previewRuntime";

export function startPreviewTrustReset(): () => void {
  const reachedRemotely = new Set<EnvironmentId>();
  const watched = new Map<EnvironmentId, () => void>();
  const sync = () => {
    const primaryEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    for (const environmentId of appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.keys()) {
      if (!watched.has(environmentId)) {
        watched.set(
          environmentId,
          appAtomRegistry.subscribe(
            environmentSession.preparedConnectionValueAtom(environmentId),
            sync,
          ),
        );
      }
      const target = readPreparedConnection(environmentId)?.target;
      if (target === undefined) continue;
      if (isLocalPreviewEnvironment(environmentId, primaryEnvironmentId)) {
        if (reachedRemotely.delete(environmentId)) clearEnvironmentPreviews(environmentId);
      } else if (
        target._tag !== "PrimaryConnectionTarget" &&
        !isDesktopLocalConnectionTarget(target)
      ) {
        reachedRemotely.add(environmentId);
      }
    }
  };
  const disposers = [
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, sync),
    appAtomRegistry.subscribe(primaryEnvironmentIdAtom, sync),
  ];
  sync();
  return () => {
    for (const dispose of disposers) dispose();
    for (const unwatch of watched.values()) unwatch();
  };
}

function clearEnvironmentPreviews(environmentId: EnvironmentId): void {
  for (const ref of appAtomRegistry.get(previewThreadRefsAtom).values()) {
    if (ref.environmentId === environmentId) clearThreadPreviewState(ref);
  }
}

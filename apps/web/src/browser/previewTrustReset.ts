import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { clearThreadPreviewState, previewThreadRefsAtom } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { previewEnvironment } from "~/state/preview";
import { environmentSession } from "~/state/session";

import { isLocalPreviewEnvironment } from "./previewRuntime";
import { advancePreviewTrustEpoch } from "./previewTrustEpoch";
import { remoteDeviceAccess } from "./remoteDeviceAccess";

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
      if (!isLocalPreviewEnvironment(environmentId, primaryEnvironmentId)) {
        reachedRemotely.add(environmentId);
      } else if (reachedRemotely.delete(environmentId) && remoteDeviceAccess() !== "off") {
        clearEnvironmentPreviews(environmentId);
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
  const events = previewEnvironment.events({ environmentId, input: {} });
  const refs = [...appAtomRegistry.get(previewThreadRefsAtom).values()].filter(
    (ref) => ref.environmentId === environmentId,
  );
  const lists = refs.map((ref) =>
    previewEnvironment.list({ environmentId, input: { threadId: ref.threadId } }),
  );
  const latestEvent = appAtomRegistry.getNodes().get(events)?.valueOption();
  advancePreviewTrustEpoch(
    environmentId,
    latestEvent?._tag === "Some" && AsyncResult.isSuccess(latestEvent.value)
      ? [latestEvent.value.value]
      : [],
  );
  for (const ref of refs) clearThreadPreviewState(ref);
  if (appAtomRegistry.getNodes().has(events)) appAtomRegistry.refresh(events);
  for (const list of lists) appAtomRegistry.refresh(list);
}

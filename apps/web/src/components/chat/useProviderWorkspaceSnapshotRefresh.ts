import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import {
  createProviderWorkspaceSnapshotRefreshAtomFamily,
  isProviderWorkspaceSnapshotScanning,
  type ProviderWorkspaceSnapshotRefreshState,
} from "@t3tools/client-runtime/providerSkills";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";

const providerWorkspaceSnapshotRefresh = createProviderWorkspaceSnapshotRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});

const idleRefreshAtom: Atom.Atom<ProviderWorkspaceSnapshotRefreshState | undefined> = Atom.make<
  ProviderWorkspaceSnapshotRefreshState | undefined
>(undefined).pipe(Atom.withLabel("provider-workspace-snapshot-refresh:idle"));

/**
 * Keeps a provider's workspace snapshot fresh for the composer's cwd while
 * mounted. Returns a check to run when the user types, and whether the cwd's
 * skills are still being scanned.
 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId | null;
  readonly gitCwd: string | null;
  readonly provider: ServerProvider | null;
}): { readonly refresh: () => void; readonly scanning: boolean } {
  const { environmentId, gitCwd, provider } = input;
  const instanceId = provider?.instanceId;
  const key = gitCwd && instanceId ? `${environmentId}:${instanceId}:${gitCwd}` : null;
  const [typedKey, setTypedKey] = useState<string | null>(null);
  const active =
    key !== null && (typedKey === key || (provider?.workspaceSnapshots?.length ?? 0) === 0);
  const atom =
    active && environmentId && gitCwd && instanceId
      ? providerWorkspaceSnapshotRefresh({ environmentId, instanceId, cwd: gitCwd })
      : idleRefreshAtom;
  const recheck = useAtomRefresh(atom);
  return {
    refresh: () => {
      if (typedKey === key) recheck();
      else setTypedKey(key);
    },
    scanning: isProviderWorkspaceSnapshotScanning(useAtomValue(atom)),
  };
}

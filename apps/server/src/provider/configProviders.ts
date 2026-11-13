// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside the pure provider mapping.
import * as NodeCrypto from "node:crypto";

import {
  type ServerConfigStreamEvent,
  type ServerProvider,
  serverProviderDeltas,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

export function workspaceSnapshotOrCatalog(
  provider: ServerProvider,
  cwd: string,
  catalogOnDemand: boolean,
) {
  const snapshots = (provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd === cwd);
  if (snapshots.length > 0 || !catalogOnDemand) return snapshots;
  return [
    {
      cwd,
      checkedAt: provider.checkedAt,
      slashCommands: provider.slashCommands,
      slashCommandsPending: true,
      skills: provider.skills,
    },
  ];
}

export function machineCatalogNames(provider: Pick<ServerProvider, "slashCommands" | "skills">) {
  return {
    slashCommands: provider.slashCommands.map(({ name }) => ({ name })),
    skills: provider.skills.map(({ description: _d, shortDescription: _s, ...skill }) => skill),
  };
}

export const machineCatalogDigest = (provider: Pick<ServerProvider, "slashCommands" | "skills">) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.slashCommands, provider.skills]))
    .digest("hex")
    .slice(0, 16);

export function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
  catalogsPerCwd: ReadonlySet<string> = new Set(),
  catalogDigests = false,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => {
    if (!catalogsPerCwd.has(provider.instanceId)) return provider;
    return catalogDigests
      ? {
          ...provider,
          slashCommands: [],
          skills: [],
          catalogDigest: machineCatalogDigest(provider),
        }
      : { ...provider, ...machineCatalogNames(provider) };
  });
}

export const withProviderStatusDeltas = (sent: ReadonlyArray<ServerProvider>) =>
  Stream.mapAccum(
    () => sent,
    (
      previous,
      event: ServerConfigStreamEvent,
    ): readonly [ReadonlyArray<ServerProvider>, ReadonlyArray<ServerConfigStreamEvent>] => {
      if (event.type === "snapshot") return [event.config.providers, [event]];
      if (event.type !== "providerStatuses") return [previous, [event]];
      const { providers } = event.payload;
      return [
        providers,
        [
          {
            version: 1,
            type: "providerStatusDeltas",
            payload: { providers: serverProviderDeltas(previous, providers) },
          },
        ],
      ];
    },
  );

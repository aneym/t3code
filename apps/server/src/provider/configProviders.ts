import type { ServerProvider } from "@t3tools/contracts";

export interface ConfigProviderShape {
  readonly workspaceSnapshotsOnDemand?: boolean;
  readonly providerCatalogsOnDemand?: boolean;
}

export function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

export function shapeConfigProviders(
  providers: ReadonlyArray<ServerProvider>,
  shape: ConfigProviderShape,
): ReadonlyArray<ServerProvider> {
  const shaped = shape.workspaceSnapshotsOnDemand
    ? withoutWorkspaceSnapshots(providers)
    : providers;
  return shape.providerCatalogsOnDemand
    ? shaped.map((provider) => ({ ...provider, skills: [], slashCommands: [] }))
    : shaped;
}

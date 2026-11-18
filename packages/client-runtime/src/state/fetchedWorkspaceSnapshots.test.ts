import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
} from "./fetchedWorkspaceSnapshots.ts";

it("merges fetched workspace snapshots only from servers that omit them", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  const codex = ProviderInstanceId.make("codex");
  const snapshot = (cwd: string, command: string) => ({
    cwd,
    checkedAt: "2026-10-25T00:00:00.000Z",
    slashCommands: [{ name: command }],
    skills: [],
  });
  const provider = (
    instanceId: ProviderInstanceId,
    workspaceSnapshots?: ReadonlyArray<ReturnType<typeof snapshot>>,
    slashCommands: ReadonlyArray<{ readonly name: string }> = [],
  ) =>
    ({
      instanceId,
      enabled: true,
      slashCommands,
      skills: [],
      ...(workspaceSnapshots ? { workspaceSnapshots } : {}),
    }) as unknown as ServerConfig["providers"][number];
  const configWith = (onDemand: boolean, providers: ServerConfig["providers"]) =>
    ({
      environment: { capabilities: { providerWorkspaceSnapshotsOnDemand: onDemand } },
      providers,
    }) as unknown as ServerConfig;
  const claudeA = snapshot("/a", "claude");
  const record = (
    current: Parameters<typeof recordFetchedWorkspaceSnapshot>[0],
    instanceId: ProviderInstanceId,
    fresh: boolean,
    reply: ServerConfig["providers"],
  ) =>
    recordFetchedWorkspaceSnapshot(
      current,
      { instanceId, cwd: "/a", fresh },
      reply,
      provider(instanceId),
    );

  let fetched = record([], claude, false, [provider(claude, [claudeA])]);
  fetched = record(fetched, codex, false, [provider(codex, [snapshot("/a", "codex")])]);
  const merged = withFetchedWorkspaceSnapshots(
    configWith(true, [provider(claude), provider(codex)]),
    fetched,
  );
  expect(merged.providers[0]?.workspaceSnapshots).toEqual([claudeA]);
  expect(
    record(fetched, claude, false, [
      provider(claude, [JSON.parse(JSON.stringify(claudeA)) as typeof claudeA]),
    ]),
  ).toBe(fetched);

  expect(
    withFetchedWorkspaceSnapshots(
      configWith(true, [
        { ...provider(claude), checkedAt: "2026-10-25T00:09:00.000Z", usageLimits: {} },
      ] as unknown as ServerConfig["providers"]),
      fetched,
    ).providers[0]?.workspaceSnapshots,
  ).toEqual([claudeA]);

  expect(
    withFetchedWorkspaceSnapshots(
      configWith(true, [provider(claude, undefined, [{ name: "live" }])]),
      fetched,
    ).providers[0]?.workspaceSnapshots,
  ).toBeUndefined();

  const digested = (catalogDigest: string, slashCommands: ReadonlyArray<{ name: string }> = []) =>
    ({ ...provider(claude, undefined, slashCommands), catalogDigest }) as ReturnType<
      typeof provider
    >;
  const fetchedByDigest = recordFetchedWorkspaceSnapshot(
    [],
    { instanceId: claude, cwd: "/a", fresh: false },
    [provider(claude, [claudeA])],
    digested("d1"),
  );
  const snapshotsFor = (current: ReturnType<typeof provider>) =>
    withFetchedWorkspaceSnapshots(configWith(true, [current]), fetchedByDigest).providers[0]
      ?.workspaceSnapshots;
  expect(snapshotsFor(digested("d1", [{ name: "loaded" }]))).toEqual([claudeA]);
  expect(snapshotsFor(digested("d2"))).toBeUndefined();

  const legacy = configWith(false, [provider(claude)]);
  expect(withFetchedWorkspaceSnapshots(legacy, fetched)).toBe(legacy);

  expect(record(fetched, claude, true, [])).toEqual([]);
});

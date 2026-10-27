import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ForkRelease } from "@t3tools/contracts";
import { environmentSession } from "~/state/session";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { AsyncResult } from "effect/reactivity";
import { APP_VERSION } from "~/branding";
import { serverEnvironment } from "~/state/server";
import { serverUpdateStateAtom } from "@t3tools/client-runtime/state/server";
import { canUpdateServer, useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  hasMacArmDesktop,
  isUnknownMethodFailure,
  releaseDate,
  releaseLabel,
} from "./forkReleaseSwitcher.logic";

export function ForkReleaseSwitcher({
  environmentId,
  releases: queryResult,
}: {
  readonly environmentId: EnvironmentId;
  readonly releases: AsyncResult.AsyncResult<
    { readonly releases: ReadonlyArray<ForkRelease> },
    unknown
  > | null;
}) {
  const query = queryResult ?? AsyncResult.success({ releases: [] });
  const environment = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const currentVersion = environment?.environment.serverVersion ?? APP_VERSION;
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [selectOpen, setSelectOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const updateState = useAtomValue(serverUpdateStateAtom(environmentId));
  const canUpdate = canUpdateServer(
    useAtomValue(environmentSession.sessionStateAtom(environmentId)),
  );
  const updateServer = useServerUpdate();
  const isDesktopManaged =
    environment?.environment.capabilities.serverSelfUpdate === "desktop-managed";
  const desktopBridge = window.desktopBridge;

  const releases = AsyncResult.isSuccess(query) ? query.value.releases : [];
  const currentRelease = releases.find((release) => release.current) ?? null;
  const selected =
    releases.find((release) => release.version === selectedVersion) ??
    currentRelease ??
    releases[0];
  const showUnknownMethodFallback = isUnknownMethodFailure(query);

  const switchServer = async (target: ForkRelease) => {
    if (switching || !canUpdate || isDesktopManaged) return;
    setSwitching(true);
    await updateServer(
      {
        environmentId,
        serverLabel: "Server",
        selfUpdate: environment?.environment.capabilities.serverSelfUpdate ?? null,
        targetVersion: target.version,
        allowDowngrade: currentVersion !== target.version && !target.latest,
      },
      { quiet: true },
    );
    setSwitching(false);
  };

  const switchToApp = async () => {
    if (switching || desktopBridge?.installDesktopVersion === undefined) return;
    setSwitching(true);
    await desktopBridge.installDesktopVersion(APP_VERSION);
    setSwitching(false);
  };

  if (query.waiting || AsyncResult.isInitial(query)) {
    return <p className="text-muted-foreground">Loading releases…</p>;
  }
  if (showUnknownMethodFallback) {
    return (
      <Button size="xs" variant="outline" disabled={switching} onClick={() => void switchToApp()}>
        Return server to {APP_VERSION}
      </Button>
    );
  }
  if (AsyncResult.isFailure(query)) {
    return <p className="text-muted-foreground">Couldn’t load releases.</p>;
  }

  const updateStatus =
    updateState.status === "idle"
      ? null
      : updateState.status === "failed"
        ? updateState.message
        : updateState.stage === "downloading"
          ? "Downloading…"
          : updateState.stage === "installing"
            ? "Installing…"
            : "Restarting…";
  const canSwitch = selected !== undefined && canUpdate && !isDesktopManaged && !switching;

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Server releases</span>
        {currentRelease === null ? null : (
          <span className="shrink-0 text-muted-foreground">{releaseLabel(currentRelease)}</span>
        )}
      </div>
      {releases.length === 0 ? (
        <p className="text-muted-foreground">No releases available.</p>
      ) : (
        <Select
          value={selected?.version ?? ""}
          onValueChange={(value) => setSelectedVersion(value)}
          open={selectOpen}
          onOpenChange={setSelectOpen}
        >
          <SelectTrigger size="sm" aria-label="Server release">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {releases.map((release) => (
              <SelectItem key={release.version} value={release.version}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{releaseLabel(release)}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {release.current ? "current" : release.latest ? "latest" : releaseDate(release)}
                    {release.cached ? " · cached" : ""}
                  </span>
                  {release.current ? <CheckIcon className="size-3" /> : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {selected !== undefined ? (
        <div className="flex flex-wrap gap-1.5">
          {!isDesktopManaged ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canSwitch}
              onClick={() => void switchServer(selected)}
            >
              Switch server
            </Button>
          ) : null}
          {desktopBridge?.installDesktopVersion !== undefined && hasMacArmDesktop(selected) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={switching}
              onClick={() => void switchToApp()}
            >
              Switch app
            </Button>
          ) : null}
        </div>
      ) : null}
      {updateStatus !== null ? (
        <p
          className={updateState.status === "failed" ? "text-destructive" : "text-muted-foreground"}
          role={updateState.status === "failed" ? "alert" : undefined}
        >
          {updateStatus}
        </p>
      ) : null}
    </div>
  );
}

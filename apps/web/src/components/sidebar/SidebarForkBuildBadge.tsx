import { GitForkIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";

import { RelativeTime } from "~/components/RelativeTime";
import { APP_VERSION } from "~/branding";
import { listForkReleases, type ForkReleaseResult } from "./forkReleaseSwitcher.logic";
import { ForkReleaseSwitcher } from "./ForkReleaseSwitcher";
import { checkUpstreamNightly, FORK_VERSION, loadForkBuildManifest } from "~/forkBuild";
import type { ForkBuildManifest, ForkVersion, UpstreamNightlyStatus } from "~/forkBuild.logic";
import { usePrimaryEnvironment } from "~/state/environments";

import { Button } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";

type Loadable<T> = { readonly status: "loading" } | { readonly status: "done"; readonly value: T };

const LOADING = { status: "loading" } as const;

export function SidebarForkBuildBadge({ onBackdrop }: { onBackdrop: boolean }) {
  if (FORK_VERSION === null) return null;
  return <ForkBuildBadge forkVersion={FORK_VERSION} onBackdrop={onBackdrop} />;
}

function ForkBuildBadge({
  forkVersion,
  onBackdrop,
}: {
  forkVersion: ForkVersion;
  onBackdrop: boolean;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState<Loadable<ForkBuildManifest | null>>(LOADING);
  const [upstream, setUpstream] = useState<Loadable<UpstreamNightlyStatus | null>>(LOADING);
  const [releases, setReleases] = useState<ForkReleaseResult | null>(null);
  const fetchReleases = useAtomCommand(listForkReleases, { reportFailure: false });

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    void loadForkBuildManifest().then((value) => setManifest({ status: "done", value }));
    void checkUpstreamNightly(forkVersion.upstreamBuild).then((value) =>
      setUpstream({ status: "done", value }),
    );
    if (primaryEnvironment !== null) {
      void fetchReleases({
        environmentId: primaryEnvironment.environmentId,
        input: undefined,
      }).then(setReleases);
    }
  };

  const upstreamIsNewer =
    upstream.status === "done" && upstream.value !== null && upstream.value.buildsAhead > 0;

  return (
    <PreviewCard open={open} onOpenChange={handleOpenChange}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={
          <Button
            aria-label={`Fork build ${forkVersion.upstreamBuild}.${forkVersion.forkRevision}${upstreamIsNewer ? ", a newer upstream nightly is out" : ""}`}
            className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
            size="icon-micro"
            variant={onBackdrop ? "media-navigation" : "ghost-muted"}
          >
            <span className="relative inline-flex">
              <GitForkIcon aria-hidden />
              {upstreamIsNewer ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning"
                />
              ) : null}
            </span>
          </Button>
        }
      />
      {open ? (
        <PreviewCardPopup align="start" side="bottom" className="w-72 max-w-[calc(100vw-2rem)]">
          <ForkBuildDetails
            environmentId={primaryEnvironment?.environmentId ?? null}
            forkVersion={forkVersion}
            manifest={manifest}
            upstream={upstream}
            releases={releases}
          />
        </PreviewCardPopup>
      ) : null}
    </PreviewCard>
  );
}

function ForkBuildDetails({
  environmentId,
  forkVersion,
  manifest,
  upstream,
  releases,
}: {
  environmentId: EnvironmentId | null;
  forkVersion: ForkVersion;
  manifest: Loadable<ForkBuildManifest | null>;
  upstream: Loadable<UpstreamNightlyStatus | null>;
  releases: ForkReleaseResult | null;
}) {
  const serverVersion = usePrimaryEnvironment()?.serverConfig?.environment.serverVersion ?? null;
  const builtAt = manifest.status === "done" ? (manifest.value?.builtAt ?? null) : null;
  const topics = manifest.status === "done" ? (manifest.value?.topics ?? []) : [];

  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          aneym build {forkVersion.upstreamBuild}.{forkVersion.forkRevision}
        </span>
        {builtAt === null ? null : (
          <span className="shrink-0 text-muted-foreground">
            built <RelativeTime timestamp={builtAt} />
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 text-muted-foreground">
        <span>Based on upstream nightly {forkVersion.upstreamBuild}</span>
        <span className={upstreamTone(upstream)}>{describeUpstream(upstream)}</span>
      </div>
      {topics.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">Fork changes</span>
          <ul className="flex flex-col gap-0.5 font-mono text-2xs text-foreground">
            {topics.map((topic) => (
              <li className="flex min-w-0 gap-2" key={topic.branch}>
                <span className="min-w-0 truncate">{topic.branch}</span>
                <span className="shrink-0 text-muted-foreground">{topic.sha.slice(0, 7)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {serverVersion !== null && serverVersion !== APP_VERSION ? (
        <div className="flex flex-col gap-0.5 border-t pt-2 font-mono text-2xs text-muted-foreground">
          <span className="truncate">UI {APP_VERSION}</span>
          <span className="truncate">Server {serverVersion}</span>
        </div>
      ) : null}
      {environmentId === null ? null : (
        <ForkReleaseSwitcher environmentId={environmentId} releases={releases} />
      )}
    </div>
  );
}

function describeUpstream(upstream: Loadable<UpstreamNightlyStatus | null>): string {
  if (upstream.status === "loading") return "Checking upstream…";
  if (upstream.value === null) return "Couldn't check upstream";
  const { newestBuild, buildsAhead, buildsAheadIsLowerBound } = upstream.value;
  if (buildsAhead === 0) return "Up to date with upstream nightly";
  const count = `${buildsAhead}${buildsAheadIsLowerBound ? "+" : ""}`;
  const noun = buildsAhead === 1 && !buildsAheadIsLowerBound ? "release" : "releases";
  return `Upstream nightly ${newestBuild} is out (${count} newer ${noun})`;
}

function upstreamTone(upstream: Loadable<UpstreamNightlyStatus | null>): string {
  return upstream.status === "done" && upstream.value !== null && upstream.value.buildsAhead > 0
    ? "text-warning-foreground"
    : "";
}

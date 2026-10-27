import { decodeForkBuildManifest } from "@t3tools/client-runtime/fork-build";
import * as Option from "effect/Option";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsForkBuildSection() {
  const manifest = Option.getOrNull(
    decodeForkBuildManifest(Constants.expoConfig?.extra?.forkBuild),
  );
  if (manifest === null) return null;

  return (
    <>
      <SettingsSection title="Fork build">
        <ListRowLayout label="Version" description={manifest.version} />
        <ListRowLayout label="Upstream" description={manifest.upstreamTag} />
        <ListRowLayout label="Built" description={manifest.builtAt} />
        {manifest.topics.length > 0 ? (
          <ListRowLayout
            label="Fork changes"
            description={manifest.topics
              .map((topic) => `${topic.branch} @ ${topic.sha.slice(0, 10)}`)
              .join("\n")}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Running JavaScript">
        <ListRowLayout
          label="Update"
          description={Updates.updateId?.slice(0, 10) ?? "Not available"}
        />
        <ListRowLayout
          label="Created"
          description={Updates.createdAt?.toISOString() ?? "Not available"}
        />
        <ListRowLayout
          label="Bundle"
          description={Updates.isEmbeddedLaunch ? "Embedded" : "Downloaded update"}
        />
        <ListRowLayout
          label="Runtime version"
          description={Updates.runtimeVersion ?? "Not available"}
        />
      </SettingsSection>
    </>
  );
}

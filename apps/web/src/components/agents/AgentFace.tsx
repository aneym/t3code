import { useState } from "react";

import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectMonogram } from "../ProjectMonogram";
import { type RailsAgent, railsAgentFaceUrl } from "./railsAgents";

export function AgentFace({
  agent,
}: {
  readonly agent: Pick<RailsAgent, "handle" | "name" | "iconProject">;
}) {
  const [failed, setFailed] = useState(false);
  if (agent.iconProject) {
    return <ProjectFavicon project={agent.iconProject} className="size-5 shrink-0" />;
  }
  if (failed) {
    const identity = deriveProjectIdentity(agent.name);
    return (
      <ProjectMonogram
        text={Array.from(identity.monogram)[0] ?? ""}
        color={identity.color}
        className="size-5 [&>svg]:rounded-full"
      />
    );
  }
  return (
    <img
      src={railsAgentFaceUrl(agent.handle)}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded-full"
    />
  );
}

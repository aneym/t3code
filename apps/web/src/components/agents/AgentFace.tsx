import { useState } from "react";

import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectMonogram } from "../ProjectMonogram";
import type { RailsAgent } from "./railsAgents";

export function AgentFace({
  agent,
}: {
  readonly agent: Pick<RailsAgent, "name" | "faceUrl" | "workProjects">;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const faceUrl = agent.faceUrl?.replace(/\/512\.png$/, "/128.png") ?? null;
  if (faceUrl !== null && faceUrl !== failedUrl) {
    return (
      <img
        src={faceUrl}
        alt=""
        aria-hidden
        draggable={false}
        onError={() => setFailedUrl(faceUrl)}
        className="size-5 shrink-0 rounded-full"
      />
    );
  }
  const project = agent.workProjects[0];
  if (project) {
    return <ProjectFavicon project={project} className="size-5 shrink-0" />;
  }
  const identity = deriveProjectIdentity(agent.name);
  return (
    <ProjectMonogram
      text={Array.from(identity.monogram)[0] ?? ""}
      color={identity.color}
      className="size-5 [&>svg]:rounded-full"
    />
  );
}

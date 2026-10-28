import { useState } from "react";

import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import { railsAgentFaceUrl } from "./railsAgents";

export function AgentFace(props: { readonly handle: string; readonly name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    const identity = deriveProjectIdentity(props.name);
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
      src={railsAgentFaceUrl(props.handle)}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded-full"
    />
  );
}

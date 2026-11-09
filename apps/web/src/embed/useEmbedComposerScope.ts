import type { ServerProvider } from "@t3tools/contracts";

import type { ComposerTrigger } from "../composer-logic";
import { useEmbedHostConnected } from "./embedHost";

const SKILL_QUERY_START = /^\p{L}/u;

export function useEmbedComposerTrigger(trigger: ComposerTrigger | null): ComposerTrigger | null {
  const embedded = useEmbedHostConnected();
  if (!embedded || trigger === null) return trigger;
  if (trigger.kind === "pull-request") return null;
  if (trigger.kind !== "skill") return trigger;
  return SKILL_QUERY_START.test(trigger.query) ? trigger : null;
}

export function useEmbedProviderSkills(skills: ServerProvider["skills"]): ServerProvider["skills"] {
  const embedded = useEmbedHostConnected();
  return embedded ? skills.filter((skill) => skill.scope === "project") : skills;
}

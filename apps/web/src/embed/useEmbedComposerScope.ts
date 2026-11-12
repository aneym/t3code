import {
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import type { ServerProvider } from "@t3tools/contracts";

import type { ComposerTrigger } from "../composer-logic";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useEmbedHostConnected } from "./embedHost";

const SKILL_QUERY_START = /^\p{L}/u;

export function useEmbedComposerTrigger(trigger: ComposerTrigger | null): ComposerTrigger | null {
  const embedded = useEmbedHostConnected();
  if (!embedded || trigger === null) return trigger;
  if (trigger.kind === "pull-request") return null;
  if (trigger.kind !== "skill") return trigger;
  return SKILL_QUERY_START.test(trigger.query) ? trigger : null;
}

const NO_SKILLS: ServerProvider["skills"] = [];
const NO_SLASH_COMMANDS: ServerProvider["slashCommands"] = [];

export function useEmbedProviderSkills(
  provider: ServerProvider | null,
  cwd: string | null,
): { skills: ServerProvider["skills"]; slashCommands: ServerProvider["slashCommands"] } {
  const embedded = useEmbedHostConnected();
  const skills = provider ? resolveProviderSkillsForCwd(provider, cwd) : NO_SKILLS;
  const slashCommands = provider
    ? resolveProviderSlashCommandsForCwd(provider, cwd)
    : NO_SLASH_COMMANDS;
  if (!embedded) return { skills, slashCommands };
  const personal = new Set(
    skills.filter((skill) => skill.scope !== "project").map((skill) => skill.name),
  );
  return {
    skills: skills.filter((skill) => skill.scope === "project"),
    slashCommands: slashCommands.filter(
      (command) => !personal.has(command.name) && !command.description?.endsWith("(user)"),
    ),
  };
}

export function useComposerMobileViewport(): boolean {
  const mobile = useMediaQuery("max-sm");
  const embedded = useEmbedHostConnected();
  return mobile && !embedded;
}

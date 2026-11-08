import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentToolProfile = Schema.Struct({
  tools: Schema.Array(TrimmedNonEmptyString),
  guidance: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type AgentToolProfile = typeof AgentToolProfile.Type;

const Profiles = Schema.Record(TrimmedNonEmptyString, AgentToolProfile);
const ProjectProfiles = Schema.Record(ProjectId, TrimmedNonEmptyString);

export const Server = {
  agentToolProfiles: Profiles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  projectAgentToolProfiles: ProjectProfiles.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
};

export const ServerPatch = {
  agentToolProfiles: Schema.optionalKey(Profiles),
  projectAgentToolProfiles: Schema.optionalKey(ProjectProfiles),
};

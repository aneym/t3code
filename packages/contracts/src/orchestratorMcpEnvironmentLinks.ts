import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, IsoDateTime } from "./baseSchemas.ts";
import { PeerLinkRenewalState } from "./peerLink.ts";

export const OrchestratorMcpEnvironmentLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Whether it answered just now. An expired link must be linked again there. */
  status: Schema.Literals(["reachable", "unreachable", "expired"]),
  /** The most the linked environment lets this one's agents do there. */
  access: AuthMcpClientAccess,
  expiresAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
  renewal: PeerLinkRenewalState,
  renewedAt: Schema.optional(IsoDateTime),
  renewalError: Schema.optional(Schema.String),
});
export type OrchestratorMcpEnvironmentLink = typeof OrchestratorMcpEnvironmentLink.Type;

export const OrchestratorMcpEnvironmentLinksResult = Schema.Struct({
  environmentId: EnvironmentId,
  links: Schema.Array(OrchestratorMcpEnvironmentLink),
  /** What to do when the machine the user means is not among `links`. */
  notListed: Schema.String,
});
export type OrchestratorMcpEnvironmentLinksResult =
  typeof OrchestratorMcpEnvironmentLinksResult.Type;

export const OrchestratorMcpEnvironmentUnlinkInput = Schema.Struct({
  environmentId: EnvironmentId.annotate({
    description: "The linked environment to forget, from t3_environment_links.",
  }),
});
export type OrchestratorMcpEnvironmentUnlinkInput =
  typeof OrchestratorMcpEnvironmentUnlinkInput.Type;

export const OrchestratorMcpEnvironmentUnlinkResult = Schema.Struct({
  environmentId: EnvironmentId,
  removed: Schema.Boolean,
});
export type OrchestratorMcpEnvironmentUnlinkResult =
  typeof OrchestratorMcpEnvironmentUnlinkResult.Type;

export const OrchestratorMcpEnvironmentRenewInput = Schema.Struct({
  environmentId: EnvironmentId.annotate({
    description: "The linked environment to renew, from t3_environment_links.",
  }),
});
export type OrchestratorMcpEnvironmentRenewInput = typeof OrchestratorMcpEnvironmentRenewInput.Type;

export const OrchestratorMcpEnvironmentRenewResult = Schema.Struct({
  environmentId: EnvironmentId,
  expiresAt: IsoDateTime,
});
export type OrchestratorMcpEnvironmentRenewResult =
  typeof OrchestratorMcpEnvironmentRenewResult.Type;

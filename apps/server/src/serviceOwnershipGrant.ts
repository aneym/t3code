// @effect-diagnostics nodeBuiltinImport:off -- All server entry points respect a live launcher reservation.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { hotSwapContext } from "./serviceChildTransport.ts";

class ServiceOwnershipGrantError extends Schema.TaggedError<ServiceOwnershipGrantError>()(
  "ServiceOwnershipGrantError",
  { cause: Schema.Defect() },
) {}

const decodeGrant = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const assertServiceOwnershipGrant = Effect.fn("serviceOwnershipGrant.assert")(function (
  stateDir: string,
) {
  return Effect.try({
    try: () => {
      const context = hotSwapContext();
      let grant: unknown;
      try {
        grant = decodeGrant(
          NodeFS.readFileSync(
            NodePath.join(stateDir, "..", "runtime", "ownership-grant.json"),
            "utf8",
          ),
        );
      } catch (cause) {
        if (
          context === undefined &&
          ((cause as NodeJS.ErrnoException).code === "ENOENT" ||
            cause instanceof SyntaxError ||
            !("code" in Object(cause)))
        )
          return;
        throw cause;
      }
      if (
        typeof grant !== "object" ||
        grant === null ||
        !("pid" in grant) ||
        typeof grant.pid !== "number" ||
        !("instanceId" in grant)
      ) {
        if (context === undefined) return;
        throw new Error("Invalid ownership reservation.");
      }
      try {
        process.kill(grant.pid, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH" && context === undefined) return;
        throw cause;
      }
      if (context?.hotSwap?.instanceId !== grant.instanceId)
        throw new Error("The launcher reserved this home for a different child.");
    },
    catch: (cause) => new ServiceOwnershipGrantError({ cause }),
  });
});

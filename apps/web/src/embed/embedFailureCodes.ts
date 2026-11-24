import {
  ConnectionBlockedReason,
  ConnectionFailureCause,
  ConnectionFailureRouteKind,
  ConnectionHop,
  ConnectionTransientReason,
} from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";

export type EmbedFailureCodes = {
  readonly reason: string | null;
  readonly hop: string | null;
  readonly failureCause: string | null;
  readonly httpStatus: number | null;
  readonly routeKind: string | null;
};

const isReason = Schema.is(Schema.Union([ConnectionTransientReason, ConnectionBlockedReason]));
const isHop = Schema.is(ConnectionHop);
const isCause = Schema.is(ConnectionFailureCause);
const isRouteKind = Schema.is(ConnectionFailureRouteKind);

const field = (failure: unknown, key: string): unknown =>
  typeof failure === "object" && failure !== null && key in failure
    ? (failure as Record<string, unknown>)[key]
    : undefined;

export function embedFailureCodes(failure: unknown): EmbedFailureCodes {
  const reason = field(failure, "reason");
  const hop = field(failure, "hop");
  const failureCause = field(failure, "failureCause");
  const httpStatus = field(failure, "httpStatus");
  const attempted = field(failure, "routeKind");
  const routeKind =
    attempted === undefined && field(failure, "via") === "relay" ? "relay" : attempted;
  return {
    reason: isReason(reason) ? reason : null,
    hop: isHop(hop) ? hop : null,
    failureCause: isCause(failureCause) ? failureCause : null,
    httpStatus:
      typeof httpStatus === "number" &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
        ? httpStatus
        : null,
    routeKind: isRouteKind(routeKind) ? routeKind : null,
  };
}

import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as CpuProfiler from "./CpuProfiler.ts";

export const CPU_PROFILE_ROUTE_PATH = "/api/debug/cpu-profile";

const CpuProfileRequest = Schema.Struct({ seconds: Schema.Finite });

export const CpuProfileResponse = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Finite,
  seconds: Schema.Finite,
});

export const CpuProfileErrorResponse = Schema.Struct({ error: Schema.String });

const authenticate = Effect.fnUntraced(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthEnvironmentMaintainScope)) {
    return yield* failEnvironmentScopeRequired(AuthEnvironmentMaintainScope);
  }
});

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

const route = (profiler: CpuProfiler.CpuProfiler["Service"]) =>
  HttpRouter.add(
    "POST",
    CPU_PROFILE_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticate();
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CpuProfileRequest)),
        Effect.option,
      );
      if (input._tag === "None") {
        return errorResponse(400, "Send a JSON body with a numeric seconds field.");
      }
      return yield* profiler.capture(input.value.seconds).pipe(
        Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
        Effect.catchTags({
          CpuProfileBusyError: (error) => Effect.succeed(errorResponse(409, error.message)),
          CpuProfileFailedError: (error) =>
            Effect.logError("CPU profile failed", { cause: error }).pipe(
              Effect.as(errorResponse(500, error.message)),
            ),
        }),
      );
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );

export const layer = Layer.unwrap(CpuProfiler.make().pipe(Effect.map(route)));

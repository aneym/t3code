import type { AgentPlacementReceipt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Invocation from "../mcp/McpInvocationContext.ts";
import type * as PlacementDecisions from "./PlacementDecisions.ts";

const NO_ANSWER = "The linked environment stopped answering.";
const messageOf = (error: unknown) =>
  Predicate.hasProperty(error, "message") && typeof error.message === "string"
    ? error.message
    : String(error);

export type Selected = PlacementDecisions.Selection & { readonly decisionKey?: string };

export type Run = <A, E, R1, R2>(
  scope: Invocation.McpInvocationScope,
  selected: Selected,
  clientRequestId: string | undefined,
  there: (requestKey: string) => Effect.Effect<A, E, R1>,
  here: Effect.Effect<A, E, R2>,
) => Effect.Effect<{ readonly result: A; readonly placement: AgentPlacementReceipt }, E, R1 | R2>;

export const make =
  (deps: {
    readonly newKey: Effect.Effect<string>;
    readonly fellBack: (
      scope: Invocation.McpInvocationScope,
      selected: Selected,
      answer: string,
    ) => Effect.Effect<AgentPlacementReceipt>;
  }): Run =>
  (scope, selected, clientRequestId, there, here) =>
    Effect.gen(function* () {
      if (selected.placement.environmentId === scope.environmentId)
        return { result: yield* here, placement: selected.placement };
      const attempt = there(clientRequestId ?? (yield* deps.newKey));
      return yield* attempt.pipe(
        Effect.catchIf(
          (error) => messageOf(error) === NO_ANSWER,
          () => attempt,
        ),
        Effect.map((result) => ({ result, placement: selected.placement })),
        Effect.catch((error) =>
          deps
            .fellBack(scope, selected, messageOf(error))
            .pipe(
              Effect.flatMap((placement) => Effect.map(here, (result) => ({ result, placement }))),
            ),
        ),
      );
    }).pipe(Effect.withSpan("PlacementFallback.run"));

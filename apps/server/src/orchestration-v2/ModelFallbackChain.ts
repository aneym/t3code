import { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const FallbackStep = Schema.Struct({
  label: Schema.String,
  modelSelection: ModelSelection,
  personChatOnly: Schema.optional(Schema.Boolean),
});
export type FallbackStep = typeof FallbackStep.Type;

type Selected = Pick<ModelSelection, "instanceId" | "model">;

export interface PoolState {
  readonly exhausted: boolean;
  readonly resetsAt?: string | undefined;
}

export interface FallbackInput {
  readonly chain: ReadonlyArray<FallbackStep>;
  readonly run: Selected;
  readonly stored: Selected;
  readonly personChat: boolean;
  readonly allowed: (step: FallbackStep) => boolean;
  readonly pool: (step: FallbackStep) => PoolState | undefined;
}

export interface ExhaustedProvider {
  readonly label: string;
  readonly resetsAt?: string | undefined;
}

export type FallbackDecision =
  | { readonly type: "none" }
  | { readonly type: "fallback"; readonly from: FallbackStep; readonly to: FallbackStep }
  | {
      readonly type: "exhausted";
      readonly from: FallbackStep;
      readonly providers: ReadonlyArray<ExhaustedProvider>;
    };

export function stepIndex(chain: ReadonlyArray<FallbackStep>, selected: Selected): number {
  const exact = chain.findIndex(
    (step) =>
      step.modelSelection.instanceId === selected.instanceId &&
      step.modelSelection.model === selected.model,
  );
  return exact >= 0
    ? exact
    : chain.findIndex((step) => step.modelSelection.instanceId === selected.instanceId);
}

function linear(input: FallbackInput, at: number): FallbackDecision {
  const storedAt = stepIndex(input.chain, input.stored);
  if (storedAt < 0 || storedAt > at) return { type: "none" };
  const to = input.chain
    .slice(at + 1)
    .find(
      (step) =>
        step.modelSelection.instanceId !== input.run.instanceId &&
        input.allowed(step) &&
        input.pool(step)?.exhausted !== true,
    );
  return to === undefined ? { type: "none" } : { type: "fallback", from: input.chain[at]!, to };
}

export function decideFallback(input: FallbackInput): FallbackDecision {
  const at = stepIndex(input.chain, input.run);
  if (at < 0) return { type: "none" };
  if (input.personChat) return linear(input, at);
  const storedAt = stepIndex(input.chain, input.stored);
  const anchor = storedAt < 0 ? at : storedAt;
  const size = input.chain.length;
  const offset = (at - anchor + size) % size;
  const rotated = input.chain.map((_, index) => input.chain[(anchor + index) % size]!);
  const ahead = rotated
    .slice(offset + 1)
    .filter(
      (step) => step.modelSelection.instanceId !== input.run.instanceId && input.allowed(step),
    );
  const ordered = [
    ...ahead.filter((step) => step.personChatOnly !== true),
    ...ahead.filter((step) => step.personChatOnly === true),
  ];
  const to = ordered.find((step) => input.pool(step)?.exhausted !== true);
  if (to !== undefined) return { type: "fallback", from: input.chain[at]!, to };
  const tried = rotated
    .slice(0, offset + 1)
    .filter((step, index) => index === offset || input.allowed(step));
  const providers = [...tried, ...ordered].map((step) => ({
    label: step.label,
    resetsAt: input.pool(step)?.resetsAt,
  }));
  return { type: "exhausted", from: input.chain[at]!, providers };
}

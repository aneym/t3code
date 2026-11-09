import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2CheckpointJson,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2ContextTransferJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderSessionJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const CACHE_CHAR_BUDGET = 48 * 1024 * 1024;
const MIN_CACHED_CHARS = 256;

interface Entry {
  readonly owner: object;
  readonly value: unknown;
  readonly next: Entry | undefined;
}

const entries = new Map<string, Entry>();
let cachedChars = 0;

const lookup = (owner: object, json: string): Entry | undefined => {
  const head = entries.get(json);
  for (let entry = head; entry !== undefined; entry = entry.next) {
    if (entry.owner === owner) {
      entries.delete(json);
      entries.set(json, head!);
      return entry;
    }
  }
  return undefined;
};

const store = (owner: object, json: string, value: unknown) => {
  const head = entries.get(json);
  if (head === undefined) cachedChars += json.length;
  else entries.delete(json);
  entries.set(json, { owner, value, next: head });
  for (const [key] of entries) {
    if (cachedChars <= CACHE_CHAR_BUDGET) break;
    entries.delete(key);
    cachedChars -= key.length;
  }
};

const memoized = <S extends Schema.Top>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  const owner = {};
  return (json: string): ReturnType<typeof decode> => {
    if (json.length < MIN_CACHED_CHARS) return decode(json);
    const hit = lookup(owner, json);
    if (hit !== undefined)
      return Effect.succeed(hit.value as S["Type"]) as ReturnType<typeof decode>;
    return Effect.tap(decode(json), (value) => Effect.sync(() => store(owner, json, value)));
  };
};

export const decodeThreadPayload = memoized(OrchestrationV2AppThreadJson);
export const decodeRunPayload = memoized(OrchestrationV2RunJson);
export const decodeRunAttemptPayload = memoized(OrchestrationV2RunAttemptJson);
export const decodeNodePayload = memoized(OrchestrationV2ExecutionNodeJson);
export const decodeSubagentPayload = memoized(OrchestrationV2SubagentJson);
export const decodeProviderSessionPayload = memoized(OrchestrationV2ProviderSessionJson);
export const decodeProviderThreadPayload = memoized(OrchestrationV2ProviderThreadJson);
export const decodeProviderTurnPayload = memoized(OrchestrationV2ProviderTurnJson);
export const decodeRuntimeRequestPayload = memoized(OrchestrationV2RuntimeRequestJson);
export const decodeMessagePayload = memoized(OrchestrationV2ConversationMessageJson);
export const decodePlanJson = memoized(OrchestrationV2PlanArtifact);
export const decodeTurnItemPayload = memoized(OrchestrationV2TurnItemJson);
export const decodeCheckpointScopePayload = memoized(OrchestrationV2CheckpointScopeJson);
export const decodeCheckpointPayload = memoized(OrchestrationV2CheckpointJson);
export const decodeContextHandoffPayload = memoized(OrchestrationV2ContextHandoffJson);
export const decodeContextTransferPayload = memoized(OrchestrationV2ContextTransferJson);

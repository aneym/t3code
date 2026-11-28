import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityPermissionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import {
  ANTIGRAVITY_TOOL_TEXT_LIMIT,
  antigravityApprovalOptions,
  antigravitySubagentModel,
  antigravitySubagentOutput,
  antigravitySubagentPrompt,
  antigravitySubagentTitle,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import { resolveAntigravityAgentsKernel } from "../../provider/Drivers/AntigravitySkills.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { sessionModelStateFromInitialize } from "@t3tools/provider-acp/server/runtimeModel";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");
const ANTIGRAVITY_GEMINI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const ANTIGRAVITY_THINKING_OPTION_IDS = new Set([
  "thought_level",
  "thinkingLevel",
  "reasoningEffort",
]);
const ANTIGRAVITY_THINKING_SUFFIX_PATTERN = /-(?:minimal|low|medium|high|max|none|xhigh)$/i;

function normalizeAntigravityBaseModel(model: string): string {
  return model.trim().replace(ANTIGRAVITY_THINKING_SUFFIX_PATTERN, "");
}

function normalizeNonThinkingOptions(
  options: ModelSelection["options"] | Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [string, unknown]> {
  if (options === undefined) return [];
  if (Array.isArray(options)) {
    return options
      .filter((option) => !ANTIGRAVITY_THINKING_OPTION_IDS.has(option.id))
      .map((option) => [option.id, option.value] as const)
      .toSorted(([a], [b]) => a.localeCompare(b));
  }
  return Object.entries(options)
    .filter(([key]) => !ANTIGRAVITY_THINKING_OPTION_IDS.has(key))
    .toSorted(([a], [b]) => a.localeCompare(b));
}

function canReuseAntigravityContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
  if (previous.instanceId !== next.instanceId) return false;
  if (normalizeAntigravityBaseModel(previous.model) !== normalizeAntigravityBaseModel(next.model)) {
    return false;
  }
  const previousEntries = normalizeNonThinkingOptions(previous.options);
  const nextEntries = normalizeNonThinkingOptions(next.options);
  if (previousEntries.length !== nextEntries.length) return false;
  return previousEntries.every(
    ([key, value], index) =>
      nextEntries[index]?.[0] === key && Object.is(nextEntries[index]?.[1], value),
  );
}

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsSteeringByInterruptRestart: false,
    goalCommands: "without_pause_resume",
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
  context: {
    ...AcpProviderCapabilitiesV2.context,
    supportsCompaction: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly userHome?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Native subagent tools report no child session ids. */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "completed"
      ? "completed"
      : toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "pending"
          ? "pending"
          : "running";
  const output = antigravitySubagentOutput(toolCall) ?? null;
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt: antigravitySubagentPrompt(toolCall) ?? "Antigravity subagent",
    title: antigravitySubagentTitle(toolCall),
    model: antigravitySubagentModel(toolCall),
    status,
    childSessionId: null,
    result: status === "completed" || status === "failed" ? output : null,
    suppressNormalTool: false,
  };
};

interface AntigravityFlavorServices {
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const antigravityClientFileRoots = (cwd: string | null) =>
    cwd === null ? [options.host.paths.attachmentsDir] : [cwd, options.host.paths.attachmentsDir];
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            clientFileReads: true,
            additionalDirectories: [options.host.paths.attachmentsDir],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          Effect.sync(reads.reset).pipe(Effect.andThen(runtime.prompt(payload, promptOptions))),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) =>
            updates.withPermit(handler(reads.repair(notification))),
          );
        },
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
            ),
      } satisfies typeof runtime;
    },
    Effect.provideService(Crypto.Crypto, options.crypto),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    makeRuntime,
    ...(options.userHome === undefined
      ? {}
      : {
          resolveAgentsKernel: ({ cwd }) =>
            resolveAntigravityAgentsKernel({
              cwd,
              userHome: options.userHome!,
              ...(options.environment === undefined ? {} : { environment: options.environment }),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, options.fileSystem),
              Effect.provideService(Path.Path, options.path),
            ),
        }),
    buildPrompt: ({ text, attachments, promptCapabilities }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        attachmentsDir: options.host.paths.attachmentsDir,
        promptCapabilities,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    settleSubagentsOnTurnCompletion: true,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    getModelContextWindow: (selection, session) => {
      if (selection.instanceId !== options.instanceId) return undefined;
      const models =
        session.sessionSetupResult.models ??
        sessionModelStateFromInitialize(session.initializeResult);
      const modelId =
        selection.model === ANTIGRAVITY_DEFAULT_MODEL ? models?.currentModelId : selection.model;
      if (!modelId) return undefined;
      const baseModelId = normalizeAntigravityBaseModel(modelId);
      const matched = models?.availableModels.find(
        (model) =>
          model.modelId === modelId || normalizeAntigravityBaseModel(model.modelId) === baseModelId,
      );
      const meta = matched?._meta;
      const reported = meta?.totalContextTokens ?? meta?.contextWindow;
      if (typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0) {
        return reported;
      }
      if (modelId.toLowerCase().startsWith("gemini")) {
        return ANTIGRAVITY_GEMINI_DEFAULT_CONTEXT_WINDOW;
      }
      return undefined;
    },
    canReuseContextUsage: canReuseAntigravityContextUsage,
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: antigravityClientFileRoots(cwd),
          request,
        }),
    },
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    toolCallContentMaxChars: ANTIGRAVITY_TOOL_TEXT_LIMIT,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    supportsCompaction: true,
    requiresSignIn: isAntigravitySignInRequiredError,
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});

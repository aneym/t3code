import type { CodexFeedbackSubmission } from "@t3tools/client-runtime/state/threads";
import type { ServerProvider, UsageLimitSourceSnapshots } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";

export const EMPTY_PROVIDERS: ServerProvider[] = [];
export const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
export const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];

export const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
export const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
export const EMPTY_TURN_ITEMS: ThreadStructure["turnItems"] = [];
export const EMPTY_AUTO_UPDATE_ENVIRONMENTS: ReadonlyArray<EnvironmentPresentation> = [];

export const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

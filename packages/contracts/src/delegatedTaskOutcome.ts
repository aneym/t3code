import * as Schema from "effect/Schema";
import { CommandId, RunId, ThreadId } from "./baseSchemas.ts";

export const DelegatedTaskOutcome = Schema.Literals(["clean", "gaps"]);
export type DelegatedTaskOutcome = typeof DelegatedTaskOutcome.Type;

export const ReportedOutcomeFields = { reportedOutcome: Schema.optional(DelegatedTaskOutcome) };

export const AwaitedFields = { awaited: Schema.optional(Schema.Literal(true)) };

export const RunOutcomeReportCommand = Schema.Struct({
  type: Schema.Literal("run.outcome.report"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: RunId,
  outcome: DelegatedTaskOutcome,
});

export const OrchestratorMcpTaskOutcomeInput = Schema.Struct({
  outcome: DelegatedTaskOutcome.annotate({
    description:
      "'clean': you did everything the task asked and verified it; the lead has nothing to act on. 'gaps': anything was left undone, unverified, blocked or needs the lead's decision.",
  }),
});
export type OrchestratorMcpTaskOutcomeInput = typeof OrchestratorMcpTaskOutcomeInput.Type;

export const OrchestratorMcpTaskOutcomeResult = Schema.Struct({
  runId: RunId,
  outcome: DelegatedTaskOutcome,
});
export type OrchestratorMcpTaskOutcomeResult = typeof OrchestratorMcpTaskOutcomeResult.Type;

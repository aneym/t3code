import * as Schema from "effect/Schema";
import { OrchestratorMcpRequestSecretResult } from "../../packages/contracts/src/orchestratorMcpSecret.ts";
import { restartSecretNote } from "../../apps/server/src/orchestration-v2/RestartSecretNote.ts";

const statuses = OrchestratorMcpRequestSecretResult.members.map((member) => member.fields.status);
export const secretResultGuidance = JSON.stringify(
  Schema.toJsonSchemaDocument(OrchestratorMcpRequestSecretResult),
);

export const secretObservation = (result: unknown) => {
  if (typeof result !== "object" || result === null || !("status" in result)) return result;
  const status = statuses.find((schema) => Schema.is(schema)(result.status));
  const guidance = status && Schema.resolveAnnotations(status)?.description;
  return guidance === undefined ? result : { ...result, guidance };
};

const attempts = new WeakMap<object, { key: unknown; count: number }>();

export const resolveSecretPrompt = (prompt: string) => {
  const match = /^\$restartSecretNote:([^:]+):(.+)$/.exec(prompt);
  return match ? restartSecretNote({ label: match[1]!, clientRequestId: match[2]! }) : prompt;
};

const resultFor = (
  sample: { readonly base: { readonly environment: { readonly cwd: string } } },
  input: Readonly<Record<string, unknown>>,
  mode = "default",
) => {
  const id = "5f0c9e2a7b4d4183a6e1c8d2b9f07a64";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(sample.base.environment.cwd)?.[0] ?? "/home/user";
  const saved =
    input.delivery === "file"
      ? { status: "saved", file: `${home}/.t3/userdata/secrets/files/${id}` }
      : { status: "saved", secretRef: mode === "default" ? `secret-ref:${id}` : "secret-ref-1" };
  const previous = attempts.get(sample);
  attempts.set(sample, {
    key: previous?.key ?? input.clientRequestId ?? "secret-ask-1",
    count: (previous?.count ?? 0) + 1,
  });
  const key = attempts.get(sample)!.key;
  if (mode === "restart-once")
    return previous && input.clientRequestId === key
      ? saved
      : { status: "restarting", clientRequestId: key };
  if (mode === "timeout-once")
    return !previous
      ? { status: "timed_out" }
      : input.clientRequestId === key
        ? { status: "cancelled" }
        : saved;
  if (mode.startsWith("key:") && input.clientRequestId !== mode.slice(4))
    return { status: "cancelled" };
  return saved;
};

export const secretResult = (...args: Parameters<typeof resultFor>) =>
  secretObservation(resultFor(...args));

export const gradeSecretRetry = (
  calls: ReadonlyArray<{
    readonly tool: string;
    readonly input: unknown;
    readonly output?: string;
    readonly step: number;
  }>,
) => {
  const index = calls.findIndex(
    (call) =>
      call.tool === "request_secret" && /"status"\s*:\s*"restarting"/.test(call.output ?? ""),
  );
  const first = calls[index];
  const next = calls.slice(index + 1).find((call) => call.tool !== "exec" && call.tool !== "wait");
  let key: unknown;
  try {
    key = JSON.parse(first?.output ?? "{}").clientRequestId;
  } catch {}
  return {
    check: "secret restart retries same key immediately without ending turn",
    pass:
      index >= 0 &&
      typeof key === "string" &&
      next?.tool === "request_secret" &&
      next.step === first!.step + 1 &&
      typeof next.input === "object" &&
      next.input !== null &&
      "clientRequestId" in next.input &&
      next.input.clientRequestId === key,
  };
};

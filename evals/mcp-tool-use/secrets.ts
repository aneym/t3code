import { restartSecretNote } from "../../apps/server/src/orchestration-v2/RestartSecretNote.ts";

const attempts = new WeakMap<object, { key: unknown; count: number }>();

export const resolveSecretPrompt = (prompt: string) => {
  const match = /^\$restartSecretNote:([^:]+):(.+)$/.exec(prompt);
  return match ? restartSecretNote({ label: match[1]!, clientRequestId: match[2]! }) : prompt;
};

export const secretResult = (
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

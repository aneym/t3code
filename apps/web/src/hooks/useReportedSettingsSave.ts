import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import { toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

export function settingsSaveFailureMessage(
  label: string,
  result: { readonly cause: Cause.Cause<unknown> },
): string {
  const error = squashAtomCommandFailure(result);
  return `Could not save on ${label}: ${error instanceof Error ? error.message : "The save failed. Try reconnecting and saving again."}`;
}

export function useReportedSettingsSave(label: string) {
  const save = useAtomCommand(serverEnvironment.updateSettings, { label, reportFailure: false });
  const { environments } = useEnvironments();
  return async (request: Parameters<typeof save>[0], title = "Setting not saved") => {
    const result = await save(request);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const environment = environments.find(
        (target) => target.environmentId === request.environmentId,
      );
      toastManager.add({
        type: "error",
        title,
        description: settingsSaveFailureMessage(
          environment?.label ?? request.environmentId,
          result,
        ),
      });
    }
    return result;
  };
}

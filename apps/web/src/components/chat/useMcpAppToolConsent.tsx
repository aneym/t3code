import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  sameMcpAppToolGrant,
  withMcpAppToolGrant,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { McpAppHostRefusal } from "@t3tools/client-runtime/mcp-apps";
import {
  makeMcpAppToolConsent,
  type McpAppToolConsentChoice,
  type McpAppToolConsentNotice,
  type McpAppToolConsentRequest,
} from "@t3tools/client-runtime/mcp-apps/tool-consent";
import { useState } from "react";

import { requestChoiceDialog, type ConfirmDialogChoice } from "~/confirmDialog";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useQuietThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const choicesFor = (canRemember: boolean): ReadonlyArray<ConfirmDialogChoice> => [
  { id: "deny-card", label: "Deny for this card", variant: "outline" },
  ...(canRemember ? [{ id: "always", label: "Always allow", variant: "outline" as const }] : []),
  { id: "allow", label: "Allow" },
];

function noticeText(server: string, notice: McpAppToolConsentNotice) {
  const blocked =
    notice.blocked === 0
      ? ""
      : ` Blocked ${notice.blocked} more ${notice.blocked === 1 ? "request" : "requests"}.`;
  return notice.kind === "denied"
    ? `${notice.tool} is denied for this card.${blocked}`
    : `You declined ${notice.tool}. T3 declines requests from ${server} for a minute.${blocked}`;
}

export function useMcpAppToolConsent(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly server: string;
  readonly beforeAsk: () => void;
}) {
  const settings = useAtomValue(serverEnvironment.configValueAtom(input.environmentId))?.settings;
  const projectId =
    useQuietThreadShell({ environmentId: input.environmentId, threadId: input.threadId })
      ?.projectId ?? null;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [notice, setNotice] = useState<McpAppToolConsentNotice | null>(null);

  const live = useStableCallback(() => ({ input, settings, projectId, updateSettings }));
  const canRemember = () => {
    const current = live();
    return (
      current.settings?.mcpAppRememberToolGrants === true &&
      current.projectId !== null &&
      readEnvironmentScope(current.input.environmentId, AuthSettingsWriteScope)
    );
  };
  const target = (tool: string) => {
    const { input: current, projectId: project } = live();
    return project === null ? null : { server: current.server, tool, projectId: project };
  };

  const [consent] = useState(() =>
    makeMcpAppToolConsent({
      now: () => performance.now(),
      canRemember,
      isGranted: (tool) => {
        const granted = target(tool);
        return (
          granted !== null &&
          (live().settings?.mcpAppToolGrants ?? []).some((grant) =>
            sameMcpAppToolGrant(grant, granted),
          )
        );
      },
      ask: async (request: McpAppToolConsentRequest, remember) => {
        live().input.beforeAsk();
        const choice = await requestChoiceDialog(
          `Allow ${live().input.server} to run ${request.title}?\n${JSON.stringify(request.arguments, null, 2)}`,
          choicesFor(remember),
        );
        if (choice === undefined) {
          throw new McpAppHostRefusal("T3 could not ask for approval here.");
        }
        return (choice ?? "cancel") as McpAppToolConsentChoice;
      },
      remember: (tool) => {
        const current = live();
        const granted = target(tool);
        if (granted === null) return;
        void current
          .updateSettings({
            environmentId: current.input.environmentId,
            input: {
              patch: {
                mcpAppToolGrants: withMcpAppToolGrant(current.settings?.mcpAppToolGrants ?? [], {
                  ...granted,
                  grantedAt: new Date().toISOString(),
                }),
              },
            },
          })
          .then((result) => {
            if (result._tag === "Success") return;
            toastManager.add({
              type: "warning",
              title: "Approval not remembered",
              description: `T3 allowed ${tool} once but could not save the approval.`,
            });
          });
      },
      onNotice: setNotice,
    }),
  );

  const noticeView =
    notice === null ? null : (
      <div className="mt-1 flex items-center justify-between gap-2 px-1 text-muted-foreground text-xs">
        <span>{noticeText(input.server, notice)}</span>
        <Button size="xs" variant="ghost" onClick={consent.reset}>
          Ask again
        </Button>
      </div>
    );

  return { approve: consent.approve, confirm: consent.confirm, noticeView };
}

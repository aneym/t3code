import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  sameMcpAppToolGrant,
  withMcpAppToolGrant,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  makeMcpAppToolConsent,
  type McpAppToolConsent,
  type McpAppToolConsentChoice,
  type McpAppToolConsentNotice,
  type McpAppToolConsentRequest,
} from "@t3tools/client-runtime/mcp-apps/tool-consent";
import { useInsertionEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export const confirmMcpAppAction = (title: string, message: string, action: string) =>
  new Promise<boolean>((resolve) => {
    Dialog.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: action, onPress: () => resolve(true) },
      ],
      // Android dismisses earlier alerts when showing another; decline dismissed requests to release their slots.
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const askToolConsent = (title: string, message: string, canRemember: boolean) =>
  new Promise<McpAppToolConsentChoice>((resolve) => {
    const choice = (id: McpAppToolConsentChoice, text: string) => ({
      text,
      onPress: () => resolve(id),
    });
    Dialog.alert(
      title,
      message,
      [
        ...(Platform.OS === "android"
          ? []
          : [{ text: "Cancel", style: "cancel" as const, onPress: () => resolve("cancel") }]),
        choice("deny-card", "Deny for this card"),
        ...(canRemember ? [choice("always", "Always allow")] : []),
        choice("allow", "Allow"),
      ],
      { cancelable: true, onDismiss: () => resolve("cancel") },
    );
  });

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
}) {
  const settings = useAtomValue(serverEnvironment.configValueAtom(input.environmentId))?.settings;
  const projectId =
    useQuietThreadShell(scopeThreadRef(input.environmentId, input.threadId))?.projectId ?? null;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [notice, setNotice] = useState<McpAppToolConsentNotice | null>(null);
  const live = useRef({ input, settings, projectId, updateSettings });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the consent gate's view of settings current before the WebView host can call it
  useInsertionEffect(() => {
    live.current = { input, settings, projectId, updateSettings };
  });

  const target = (tool: string) => {
    const { input: current, projectId: project } = live.current;
    return project === null ? null : { server: current.server, tool, projectId: project };
  };

  const gate = useRef<McpAppToolConsent | null>(null);
  const consent = () => {
    if (gate.current !== null) return gate.current;
    gate.current = makeMcpAppToolConsent({
      now: () => performance.now(),
      canRemember: () =>
        live.current.settings?.mcpAppRememberToolGrants === true &&
        live.current.projectId !== null &&
        readEnvironmentScope(live.current.input.environmentId, AuthSettingsWriteScope),
      isGranted: (tool) => {
        const granted = target(tool);
        return (
          granted !== null &&
          (live.current.settings?.mcpAppToolGrants ?? []).some((grant) =>
            sameMcpAppToolGrant(grant, granted),
          )
        );
      },
      ask: (request, canRemember) =>
        askToolConsent(
          `Allow ${live.current.input.server} to run ${request.title}?`,
          JSON.stringify(request.arguments, null, 2),
          canRemember,
        ),
      remember: (tool) => {
        const current = live.current;
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
            Dialog.alert(
              "Approval not remembered",
              `T3 allowed ${tool} once but could not save the approval.`,
            );
          });
      },
      onNotice: setNotice,
    });
    return gate.current;
  };

  const noticeView =
    notice === null ? null : (
      <View className="mb-2 flex-row items-center justify-between gap-2 px-1">
        <Text className="flex-1 text-xs text-foreground-muted">
          {noticeText(input.server, notice)}
        </Text>
        <Button label="Ask again" tone="text" onPress={() => consent().reset()} />
      </View>
    );

  return {
    approve: (request: McpAppToolConsentRequest) => consent().approve(request),
    confirm: (label: string, ask: () => Promise<boolean>) => consent().confirm(label, ask),
    noticeView,
  };
}

import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  providerSetupStage,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderSetupStage,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DownloadProgress } from "./DownloadProgress";
import { ProviderCliSignInStep } from "./ProviderCliSignInStep";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };

const STAGE_TITLES: Record<ProviderSetupStage["stage"], string> = {
  notInstalled: "Not installed",
  installing: "Installing",
  signedOut: "Signed out",
  signingIn: "Signing in",
  ready: "Ready",
  failed: "Not ready",
};

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function installingText(stage: Extract<ProviderSetupStage, { stage: "installing" }>): string {
  if (stage.phase === "extracting") return "Extracting files.";
  if (stage.phase === "verifying") return "Checking the download.";
  return stage.totalBytes === null
    ? `Downloaded ${megabytes(stage.downloadedBytes)}.`
    : `Downloaded ${megabytes(stage.downloadedBytes)} of ${megabytes(stage.totalBytes)}.`;
}

export function ProviderCliSetupSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
}) {
  const canManage = useAtomValue(
    serverEnvironment.startProviderInstall.permissionAtom(environmentId),
  );
  const canInstall = provider.setup?.canInstall === true;
  const canSignIn = provider.setup?.canAuthenticate === true;
  const target = { environmentId, input: { instanceId } };
  const installQuery = useEnvironmentQuery(
    canInstall ? serverEnvironment.providerInstallState(target) : null,
  );
  const authQuery = useEnvironmentQuery(
    canManage && canSignIn ? serverEnvironment.providerAuthState(target) : null,
  );
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, COMMAND_OPTIONS);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, COMMAND_OPTIONS);
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, COMMAND_OPTIONS);
  const respondAuth = useAtomCommand(serverEnvironment.respondProviderAuth, COMMAND_OPTIONS);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, COMMAND_OPTIONS);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, COMMAND_OPTIONS);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const install = installQuery.data;
  const auth = authQuery.data;
  const stage = providerSetupStage({ provider, install, auth });
  const name = provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver);
  const methods = auth?.methods ?? [];
  const selectedMethod = methods.find((method) => method.id === methodId) ?? methods[0];
  const interaction = auth?.interaction ?? null;
  const signInUrl =
    (interaction !== null && "url" in interaction ? interaction.url : undefined) ??
    auth?.authorizationUrl ??
    null;
  const disabled = pending;

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command().catch(() => null);
    pendingRef.current = false;
    setPending(false);
    if (result === null) {
      setError("Something went wrong. Try again.");
      return false;
    }
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Something went wrong. Try again.");
    }
    return false;
  }

  const installNow = () => void run(() => startInstall(target));
  const signInNow = () =>
    void run(() =>
      startAuth({
        environmentId,
        input: { instanceId, ...(selectedMethod ? { methodId: selectedMethod.id } : {}) },
      }),
    );

  function openSignInPage(url: string) {
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => setError("Could not open the sign-in page. Copy the link instead."));
  }

  function submitCode(fieldName: string, value: string) {
    if (!auth?.flowId || interaction === null) return Promise.resolve(false);
    const flowId = auth.flowId;
    return run(() =>
      respondAuth({
        environmentId,
        input: {
          instanceId,
          flowId,
          interactionId: interaction.id,
          response: { type: "credentials", values: { [fieldName]: value } },
        },
      }),
    );
  }

  function signOut() {
    void ensureLocalApi()
      .dialogs.confirm(
        `Sign out of ${name} on ${environmentLabel}? Running chats that use this sign-in stop. Chat history is kept.`,
      )
      .then((confirmed) => {
        if (confirmed) void run(() => logout(target));
      });
  }

  let description: ReactNode;
  let control: ReactNode = null;
  let details: ReactNode = null;
  switch (stage.stage) {
    case "notInstalled":
      description = canInstall
        ? `Install ${name} on ${environmentLabel} to use it.`
        : `${name} is not installed on ${environmentLabel}.`;
      if (canManage && canInstall)
        control = (
          <Button size="sm" variant="outline" disabled={disabled} onClick={installNow}>
            Install
          </Button>
        );
      break;
    case "installing": {
      description = installingText(stage);
      const operationId = install?.operationId ?? null;
      if (canManage && operationId)
        control = (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run(() => cancelInstall({ environmentId, input: { instanceId, operationId } }))
            }
          >
            Cancel
          </Button>
        );
      details = (
        <div className="grid gap-2 pb-2">
          <div className="h-1">
            {stage.phase === "downloading" && stage.totalBytes ? (
              <DownloadProgress
                label={`${name} download`}
                downloadedBytes={stage.downloadedBytes}
                totalBytes={stage.totalBytes}
              />
            ) : null}
          </div>
          {install?.download && install.download !== "fresh" && install.message ? (
            <p className="text-xs text-muted-foreground">{install.message}</p>
          ) : null}
        </div>
      );
      break;
    }
    case "signedOut":
      description = canSignIn
        ? `Sign in to use ${name} here.`
        : `Sign in to ${name} on ${environmentLabel} to use it.`;
      if (canManage && canSignIn)
        control = (
          <>
            {methods.length > 1 ? (
              <Select
                value={selectedMethod?.id ?? ""}
                disabled={disabled}
                onValueChange={(value) => setMethodId(value)}
              >
                <SelectTrigger size="sm" aria-label="Sign-in method" className="w-44">
                  <SelectValue>{selectedMethod?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {methods.map((method) => (
                    <SelectItem key={method.id} value={method.id}>
                      {method.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !auth || !provider.enabled}
              onClick={signInNow}
            >
              Sign in
            </Button>
          </>
        );
      break;
    case "signingIn":
      description =
        auth?.phase === "starting"
          ? "Starting sign-in."
          : auth?.phase === "verifying"
            ? "Checking your account."
            : interaction?.type === "deviceCode"
              ? "Open the sign-in page and enter the code."
              : "Finish signing in on the sign-in page.";
      if (canManage && auth?.flowId) {
        const flowId = auth.flowId;
        control = (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run(() => cancelAuth({ environmentId, input: { instanceId, flowId } }))
            }
          >
            Cancel
          </Button>
        );
      }
      details = (
        <ProviderCliSignInStep
          url={auth?.phase === "waiting" ? signInUrl : null}
          interaction={auth?.phase === "waiting" ? interaction : null}
          disabled={disabled || !canManage}
          onOpen={openSignInPage}
          onSubmitCode={submitCode}
        />
      );
      break;
    case "ready":
      description = provider.auth.email?.trim() ? (
        <span>
          Signed in as{" "}
          <RedactedSensitiveText
            key={provider.auth.email}
            value={provider.auth.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="max-w-full truncate"
          />
        </span>
      ) : provider.auth.label?.trim() ? (
        `Signed in with ${provider.auth.label}.`
      ) : (
        "Signed in."
      );
      if (canManage && canSignIn && provider.auth.status === "authenticated")
        control = (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={signOut}>
            Sign out
          </Button>
        );
      break;
    case "failed":
      description = <span className="[overflow-wrap:anywhere]">{stage.reason}</span>;
      if (canManage && stage.step === "install" && canInstall)
        control = (
          <Button size="sm" variant="outline" disabled={disabled} onClick={installNow}>
            Retry
          </Button>
        );
      if (canManage && stage.step === "signIn" && canSignIn)
        control = (
          <Button size="sm" variant="outline" disabled={disabled || !auth} onClick={signInNow}>
            Retry
          </Button>
        );
      break;
  }

  return (
    <SettingsRow
      title={STAGE_TITLES[stage.stage]}
      description={<span role="status">{description}</span>}
      control={
        control ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">{control}</div>
        ) : null
      }
    >
      {details || error ? (
        <>
          {details}
          {error ? (
            <p role="alert" className="pb-2 text-xs text-destructive [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsRow>
  );
}

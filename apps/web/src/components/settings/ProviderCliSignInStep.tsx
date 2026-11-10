import type { ProviderAuthInteraction } from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function CopyButton({
  label,
  value,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-sm"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() => void writeTextToClipboard(value, label)}
          >
            <CopyIcon />
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ProviderCliSignInStep({
  url,
  interaction,
  disabled,
  onOpen,
  onSubmitCode,
}: {
  readonly url: string | null;
  readonly interaction: ProviderAuthInteraction | null;
  readonly disabled: boolean;
  readonly onOpen: (url: string) => void;
  readonly onSubmitCode: (fieldName: string, value: string) => Promise<boolean>;
}) {
  const [code, setCode] = useState("");
  const field = interaction?.type === "credentials" ? interaction.fields[0] : undefined;
  if (url === null && interaction?.type !== "deviceCode" && field === undefined) return null;
  return (
    <div className="grid gap-3 py-2 text-xs">
      {url ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onOpen(url)}>
            Open sign-in page
          </Button>
          <CopyButton label="Copy sign-in link" value={url} disabled={disabled} />
          <span className="min-w-0 truncate text-muted-foreground">{urlHost(url)}</span>
        </div>
      ) : null}
      {interaction?.type === "deviceCode" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Enter this code on the sign-in page:</span>
          <code
            data-device-code=""
            className="select-all rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground"
          >
            {interaction.userCode}
          </code>
          <CopyButton label="Copy code" value={interaction.userCode} disabled={disabled} />
        </div>
      ) : null}
      {field ? (
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim()) return;
            void onSubmitCode(field.name, code.trim()).then((sent) => {
              if (sent) setCode("");
            });
          }}
        >
          <label className="text-muted-foreground" htmlFor={`cli-sign-in-${interaction?.id}`}>
            If the page shows a code, paste it here.
          </label>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id={`cli-sign-in-${interaction?.id}`}
              size="sm"
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              aria-label={field.label}
              placeholder="Code"
              value={code}
              disabled={disabled}
              maxLength={16_384}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={disabled || !code.trim()}>
              Continue
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

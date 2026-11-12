import { sameMcpAppToolGrant, type McpAppToolGrant } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function McpAppToolGrantSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const projects = useProjects();
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const rows = targets.flatMap((target) =>
    target.settings.mcpAppToolGrants
      .filter((grant) => target.projectId === null || grant.projectId === target.projectId)
      .map((grant) => ({ target, grant })),
  );
  const projectTitle = (environmentId: string, grant: McpAppToolGrant) =>
    projects.find(
      (project) => project.environmentId === environmentId && project.id === grant.projectId,
    )?.title ?? "a removed project";

  const revoke = (target: (typeof targets)[number], grant: McpAppToolGrant) =>
    void persistServer({
      environmentId: target.environmentId,
      input: {
        patch: {
          mcpAppToolGrants: target.settings.mcpAppToolGrants.filter(
            (existing) => !sameMcpAppToolGrant(existing, grant),
          ),
        },
      },
    }).then((result) => {
      if (result._tag === "Success") return;
      toastManager.add({
        type: "error",
        title: "Approval not revoked",
        description: `T3 could not revoke ${grant.tool} on ${target.label}.`,
      });
    });

  return (
    <SettingsSection id="mcp-apps" title="MCP apps">
      <SettingsRow
        {...searchableSetting("mcp-app-remember-tool-grants")}
        serverScoped
        settingKeys={["mcpAppRememberToolGrants"]}
        description="Offer Always allow when an MCP app asks to run a tool, and skip the prompt for tools you always allowed in that project. Off asks every time."
        resetAction={
          settings.mcpAppRememberToolGrants !==
          DEFAULT_UNIFIED_SETTINGS.mcpAppRememberToolGrants ? (
            <SettingResetButton
              label="remembered MCP app approvals"
              onClick={() =>
                updateSettings({
                  mcpAppRememberToolGrants: DEFAULT_UNIFIED_SETTINGS.mcpAppRememberToolGrants,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["mcpAppRememberToolGrants"]}
            checked={settings.mcpAppRememberToolGrants}
            onCheckedChange={(checked) =>
              updateSettings({ mcpAppRememberToolGrants: Boolean(checked) })
            }
            aria-label="Remember MCP app approvals"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("mcp-app-tool-grants")}
        description={
          rows.length === 0
            ? "No MCP app tools are always allowed."
            : "MCP app tools that run without asking. Revoke one to be asked again."
        }
      >
        {rows.length === 0 ? null : (
          <ul className="mt-2 flex flex-col gap-1">
            {rows.map(({ target, grant }) => (
              <li
                key={`${target.environmentId}:${grant.server}:${grant.tool}:${grant.projectId}`}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {grant.server} · {grant.tool}
                  <span className="text-muted-foreground">
                    {" "}
                    in {projectTitle(target.environmentId, grant)}
                    {targets.length > 1 ? ` on ${target.label}` : ""}
                  </span>
                </span>
                <Button size="xs" variant="outline" onClick={() => revoke(target, grant)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

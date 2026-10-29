import type { McpInvocationScope } from "./McpInvocationContext.ts";

const OWNER_CLI_PRINCIPAL = "owner-cli";

export const requestPrincipal = (scope: McpInvocationScope): string =>
  scope.client?.ownerCli === true ? OWNER_CLI_PRINCIPAL : scope.requestNamespace;

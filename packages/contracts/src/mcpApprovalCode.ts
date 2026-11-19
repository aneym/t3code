import {
  AuthMcpClientAccess,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthGrantScope,
} from "./auth.ts";

/** The scopes an agent session gets for an access level, and a pairing code must carry. */
export const mcpClientScopes = (access: AuthMcpClientAccess): ReadonlyArray<AuthGrantScope> =>
  access === "read-only"
    ? [AuthOrchestrationReadScope]
    : access === "full-access"
      ? [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthSettingsWriteScope,
          AuthSourceControlWriteScope,
        ]
      : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

/** The random part of a one-time pairing code: this many characters from this alphabet. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;

const MCP_APPROVAL_CODE_PREFIXES = {
  "read-only": "READ",
  "approval-required": "SUPERVISED",
  "auto-accept-edits": "EDITS",
  auto: "AUTO",
  "full-access": "FULL",
} as const satisfies Record<AuthMcpClientAccess, string>;

const MCP_APPROVAL_CODE_PATTERN = new RegExp(
  `^(${Object.values(MCP_APPROVAL_CODE_PREFIXES).join("|")})-([${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}})$`,
  "i",
);

/** A pairing code that approves one agent sign-in at `access`, such as `AUTO-Q8RZ3NWD5KTC`. */
export const mcpApprovalCode = (access: AuthMcpClientAccess, token: string): string =>
  `${MCP_APPROVAL_CODE_PREFIXES[access]}-${token}`;

/** The level a code approves and the code as issued, or undefined for any other code. */
export function parseMcpApprovalCode(
  code: string,
): { readonly access: AuthMcpClientAccess; readonly code: string } | undefined {
  const match = MCP_APPROVAL_CODE_PATTERN.exec(code.trim());
  if (match === null) return undefined;
  const prefix = match[1]!.toUpperCase();
  const access = AuthMcpClientAccess.literals.find(
    (level) => MCP_APPROVAL_CODE_PREFIXES[level] === prefix,
  );
  return access && { access, code: mcpApprovalCode(access, match[2]!.toUpperCase()) };
}

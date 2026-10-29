import {
  type AuthMcpAuthorizationServerMetadata,
  type AuthMcpProtectedResourceMetadata,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

const MCP_OAUTH_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

export interface McpOAuthUrls {
  readonly issuer: string;
  readonly resource: string;
}

export const requestUrls = (request: HttpServerRequest.HttpServerRequest): McpOAuthUrls => {
  const origin = Option.match(HttpServerRequest.toURL(request), {
    onNone: () => "http://localhost",
    onSome: (url) => url.origin,
  });
  return { issuer: origin, resource: `${origin}/mcp` };
};

export const protectedResourceMetadata = (
  urls: McpOAuthUrls,
): AuthMcpProtectedResourceMetadata => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  scopes_supported: MCP_OAUTH_SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "T3 Code",
});

export const authorizationServerMetadata = (
  urls: McpOAuthUrls,
): AuthMcpAuthorizationServerMetadata => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: MCP_OAUTH_SCOPES,
  authorization_response_iss_parameter_supported: true,
});

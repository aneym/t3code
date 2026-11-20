import type * as EffectAcpSchema from "effect-acp/compat";

export type AcpAuthenticateMeta = NonNullable<EffectAcpSchema.AuthenticateRequest["_meta"]>;
type MetaValue = AcpAuthenticateMeta[string];

export function makeAuthenticateRequest(
  methodId: string,
  meta: AcpAuthenticateMeta | undefined,
): EffectAcpSchema.AuthenticateRequest {
  return meta === undefined ? { methodId } : { methodId, _meta: meta };
}

function isMetaObject(value: MetaValue): value is { readonly [key: string]: MetaValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactHeaders(value: MetaValue): MetaValue {
  if (!isMetaObject(value)) return value;
  const headers = value.headers;
  if (headers === undefined || !isMetaObject(headers)) return value;
  return {
    ...value,
    headers: Object.fromEntries(Object.keys(headers).map((name) => [name, "[redacted]"])),
  };
}

export function loggableAuthenticateRequest(
  request: EffectAcpSchema.AuthenticateRequest,
): EffectAcpSchema.AuthenticateRequest {
  const meta = request._meta;
  if (meta === undefined || meta === null) return request;
  return {
    ...request,
    _meta: Object.fromEntries(
      Object.entries(meta).map(([key, value]) => [key, redactHeaders(value)]),
    ),
  };
}

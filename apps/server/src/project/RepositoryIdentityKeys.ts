import type { RepositoryIdentity } from "@t3tools/contracts";

export const repositoryIdentityKeys = (
  identity: Pick<RepositoryIdentity, "canonicalKey" | "origin"> | null | undefined,
): ReadonlyArray<string> => {
  if (identity == null) return [];
  const origin = identity.origin?.canonicalKey;
  return origin === undefined || origin === identity.canonicalKey
    ? [identity.canonicalKey]
    : [identity.canonicalKey, origin];
};

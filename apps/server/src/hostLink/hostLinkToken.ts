import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const HOST_LINK_TOKEN_SECRET = "host-link-token";

export const readHostLinkToken = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap((secrets) => secrets.get(HOST_LINK_TOKEN_SECRET)),
  Effect.map((value) =>
    Option.match(value, {
      onNone: () => null,
      onSome: (bytes) => new TextDecoder().decode(bytes).trim() || null,
    }),
  ),
  Effect.orElseSucceed(() => null),
);

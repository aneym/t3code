import { type ConnectionNames, T3_CONNECTION_NAMES } from "@t3tools/client-runtime/connection";

import { inEmbedPage } from "./embedProtocol";

const EMBED_CONNECTION_NAMES: ConnectionNames = {
  app: "the app",
  connect: "the connection service",
  connectAccount: "connection service account",
  olderApp: "an older version of the app",
  statusCommand: null,
};

export function connectionNamesHere(): ConnectionNames {
  return inEmbedPage() ? EMBED_CONNECTION_NAMES : T3_CONNECTION_NAMES;
}

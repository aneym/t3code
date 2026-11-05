import type { ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

const claimedTabs = new Set<string>();
const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

const decodeClaim = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals(["claim", "releaseClaim"]),
      threadId: Schema.String,
      tabId: Schema.String,
    }),
  ),
);
const decodeTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      threadId: Schema.String,
      tabId: Schema.optional(Schema.String),
    }),
  ),
);

const allowsRemoteControl = (settings: Option.Option<ClientSettings>) =>
  Option.match(settings, {
    onNone: () => false,
    onSome: (value) => value.browserAllowRemoteDeviceTabs && value.browserAllowRemoteDeviceControl,
  });

export const revokeUnlessAllowed = (settings: ClientSettings) => {
  if (!allowsRemoteControl(Option.some(settings))) claimedTabs.clear();
};

export const handleClaimLine = Effect.fn("desktop.remoteBrowserClaims.handleClaimLine")(function* (
  line: string,
) {
  const claim = decodeClaim(line);
  if (Option.isNone(claim)) return false;
  const key = keyOf(claim.value.threadId, claim.value.tabId);
  if (claim.value.type === "releaseClaim") {
    claimedTabs.delete(key);
    return true;
  }
  const store = yield* DesktopClientSettings.DesktopClientSettings;
  const settings = yield* store.get.pipe(Effect.orElseSucceed(() => Option.none()));
  if (allowsRemoteControl(settings)) claimedTabs.add(key);
  return true;
});

export const isClaimed = (threadId: string, tabId: string) =>
  claimedTabs.has(keyOf(threadId, tabId));

export const admitsRemoteCommand = (line: string) => {
  const target = decodeTarget(line);
  if (Option.isNone(target)) return false;
  const { threadId, tabId } = target.value;
  if (tabId !== undefined) return isClaimed(threadId, tabId);
  return [...claimedTabs].some((key) => key.startsWith(`${threadId}\u0000`));
};

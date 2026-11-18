import { McpAppHostRefusal } from "@t3tools/client-runtime/mcp-apps";
import type { McpAppToolInfo } from "@t3tools/contracts";

import { embedPressHeard, reportEmbedPress } from "~/embed/embedPress";
import type { EmbedPress } from "~/embed/embedProtocol";
import { frameActivated, pageInputRecent, type FrameClicks } from "./mcpAppActivation";
import { clickConsentAllowed } from "./mcpAppClickConsent";

export const consentToMcpAppCall = async ({
  clicks,
  frame,
  press,
  toolInfo,
  ask,
}: {
  readonly clicks: FrameClicks;
  readonly frame: HTMLIFrameElement;
  readonly press: EmbedPress;
  readonly toolInfo: () => Promise<McpAppToolInfo>;
  readonly ask: (message: string) => Promise<boolean>;
}): Promise<void> => {
  const { server, tool } = press;
  const click = clicks.peek();
  const key = click === undefined ? clicks.peekKey() : undefined;
  const info = await toolInfo();
  if (!info.callable) throw new McpAppHostRefusal({ message: "This app cannot call that tool." });
  const allowed = info.destructive === false && clickConsentAllowed(server, tool);
  let pressed = allowed && clicks.take(click);
  let asked = false;
  if (
    !info.readOnly &&
    !pressed &&
    allowed &&
    embedPressHeard(server, tool) &&
    clicks.takeKey(key)
  ) {
    asked = true;
    pressed = await reportEmbedPress(press);
  } else if (pressed) {
    await reportEmbedPress(press);
  }
  if (info.readOnly || pressed) return;
  const cardPress = !asked && frameActivated(frame) && !pageInputRecent();
  const approved = await ask(
    `Allow ${server} to run ${info.title ?? tool}?\n${JSON.stringify(press.arguments, null, 2)}`,
  );
  if (approved !== true) throw new McpAppHostRefusal({ message: "Declined by the user." });
  if (cardPress) await reportEmbedPress(press);
};

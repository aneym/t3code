import * as Layer from "effect/Layer";

import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

export const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(Layer.merge(DesktopBrowserChannel.layer, PreviewAgentActivity.layer)),
);

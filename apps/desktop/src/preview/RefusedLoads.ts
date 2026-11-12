import type {
  Event,
  OnBeforeRequestListenerDetails,
  WebContents,
  WebContentsDidStartNavigationEventParams,
} from "electron";

interface Navigation {
  generation: number;
  settled: boolean;
  refused: string | undefined;
}

export interface PendingLoad {
  readonly navigation: Navigation;
  readonly generation: number;
  readonly url: string;
}

const navigations = new Map<number, Navigation>();

export const track = (contents: WebContents) => {
  const id = contents.id;
  const navigation: Navigation = { generation: 0, settled: false, refused: undefined };
  navigations.set(id, navigation);
  contents.on("did-start-navigation", (event: Event<WebContentsDidStartNavigationEventParams>) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    navigation.generation += 1;
    navigation.settled = false;
    navigation.refused = undefined;
  });
  contents.on("did-stop-loading", () => {
    navigation.settled = true;
    setImmediate(() => {
      const url = navigation.refused;
      if (url === undefined || contents.isDestroyed() || contents.isLoadingMainFrame()) return;
      navigation.refused = undefined;
      contents.emit("did-fail-load", {}, -20, "ERR_BLOCKED_BY_CLIENT", url, true);
    });
  });
  contents.once("destroyed", () => navigations.delete(id));
};

export const pending = (details: OnBeforeRequestListenerDetails): PendingLoad | undefined => {
  if (details.resourceType !== "mainFrame" || details.webContentsId === undefined) return;
  const navigation = navigations.get(details.webContentsId);
  if (!navigation) return;
  return { navigation, generation: navigation.generation, url: details.url };
};

export const refused = (load: PendingLoad | undefined) => {
  if (!load) return;
  const { navigation } = load;
  if (navigation.generation !== load.generation || navigation.settled) return;
  navigation.refused = load.url;
};

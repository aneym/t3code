import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerSettingsService } from "./serverSettings.ts";

const EMBED_PATH_PREFIX = "/embed/";

function frameSource(entry: string): string | null {
  if (!URL.canParse(entry)) return null;
  const url = new URL(entry);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
}

function frameAncestors(settings: ServerSettings | null): string {
  const sources = settings?.embedModeEnabled
    ? [
        ...new Set(
          settings.embedAllowedOrigins.flatMap((entry) => {
            const source = frameSource(entry);
            return source === null ? [] : [source];
          }),
        ),
      ]
    : [];
  return `frame-ancestors ${sources.length > 0 ? sources.join(" ") : "'none'"}`;
}

export const layerEmbedFrameAncestors = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* httpEffect;
      if (!request.url.startsWith(EMBED_PATH_PREFIX)) return response;
      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      return HttpServerResponse.setHeader(
        response,
        "Content-Security-Policy",
        frameAncestors(settings),
      );
    }),
  { global: true },
);

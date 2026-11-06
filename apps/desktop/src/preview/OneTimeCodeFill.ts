import { clipboard, ipcMain, type IpcMainEvent, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { ONE_TIME_CODE_FIELD_CHANNEL, ONE_TIME_CODE_FILL_CHANNEL } from "./GuestProtocol.ts";

const CODE = /^(?:[A-Za-z]{1,3}-)?\d{4,10}$/u;
const POLL_INTERVAL = "400 millis";
const MAX_POLLS = 750;

const readClipboard = Effect.promise(() => clipboard.readText()).pipe(
  Effect.map((text) => text.trim()),
);

const fillWhenCopied = Effect.fn("PreviewOneTimeCode.fillWhenCopied")(function* (
  guest: WebContents,
) {
  const baseline = yield* readClipboard;
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    yield* Effect.sleep(POLL_INTERVAL);
    if (guest.isDestroyed()) return;
    const text = yield* readClipboard;
    if (text !== baseline && CODE.test(text)) {
      guest.send(ONE_TIME_CODE_FILL_CHANNEL, text);
      return;
    }
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const watches = new Map<number, Fiber.Fiber<void>>();
    const enabled = clientSettings.get.pipe(
      Effect.map(
        Option.match({
          onNone: () => true,
          onSome: (settings) => settings.browserFillOneTimeCodes,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
    const stop = (guestId: number) => {
      const fiber = watches.get(guestId);
      if (!fiber) return;
      watches.delete(guestId);
      runFork(Fiber.interrupt(fiber));
    };
    const onField = (event: IpcMainEvent, focused: unknown) => {
      const guest = event.sender;
      if (!guest.hostWebContents) return;
      stop(guest.id);
      if (focused !== true) return;
      const fiber = runFork(
        Effect.flatMap(enabled, (on) => (on ? fillWhenCopied(guest) : Effect.void)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (watches.get(guest.id) === fiber) watches.delete(guest.id);
            }),
          ),
        ),
      );
      watches.set(guest.id, fiber);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(ONE_TIME_CODE_FIELD_CHANNEL, onField)),
      () =>
        Effect.sync(() => {
          ipcMain.removeListener(ONE_TIME_CODE_FIELD_CHANNEL, onField);
          for (const guestId of watches.keys()) stop(guestId);
        }),
    );
  }),
);

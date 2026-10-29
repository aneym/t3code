// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Runs at module load, before ready and outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

const isolatedUserData = process.env.T3CODE_DESKTOP_USER_DATA?.trim();

const HIDDEN_WINDOW_METHODS = [
  "show",
  "showInactive",
  "focus",
  "moveTop",
  "maximize",
  "restore",
  "setFullScreen",
  "setSimpleFullScreen",
] as const;

const DENIED_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "media",
  "display-capture",
  "geolocation",
  "openExternal",
  "fullscreen",
  "pointerLock",
  "keyboardLock",
]);

const ignore = () => undefined;

const denyPermissions = () => {
  const session = Electron.session.defaultSession;
  session.setPermissionCheckHandler((_contents, permission) => !DENIED_PERMISSIONS.has(permission));
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(!DENIED_PERMISSIONS.has(permission)),
  );
};

const dismissedResponse = (options: Electron.MessageBoxOptions) => {
  if (options.cancelId !== undefined) return options.cancelId;
  const index = (options.buttons ?? []).findIndex((label) =>
    ["cancel", "no"].includes(label.toLowerCase()),
  );
  return index === -1 ? 0 : index;
};

const hideWebContents = (contents: Electron.WebContents) => {
  contents.openDevTools = ignore;
  const setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = (handler) =>
    setWindowOpenHandler((details) => {
      const response = handler(details);
      if (response.action === "deny") return response;
      return {
        ...response,
        overrideBrowserWindowOptions: { ...response.overrideBrowserWindowOptions, show: false },
      };
    });
  contents.setWindowOpenHandler(() => ({ action: "allow" }));
};

const captureWindows = async (directory: string) => {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  await Promise.all(
    Electron.BrowserWindow.getAllWindows().map(async (window) => {
      const image = await window.webContents.capturePage();
      await NodeFS.promises.writeFile(
        NodePath.join(directory, `${stamp}-${window.id}.png`),
        image.toPNG(),
      );
    }),
  );
};

const watchCaptureRequests = (directory: string) => {
  const requestPath = NodePath.join(directory, "request");
  const capture = () => {
    if (!NodeFS.existsSync(requestPath)) return;
    if (Electron.BrowserWindow.getAllWindows().length === 0) return;
    NodeFS.rmSync(requestPath, { force: true });
    captureWindows(directory).catch((error: unknown) => {
      process.stderr.write(`isolated capture failed: ${String(error)}\n`);
    });
  };
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.watch(directory, (_event, name) => {
    if (name === "request") capture();
  });
  Electron.app.on("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", capture);
  });
};

if (isolatedUserData) {
  process.env.T3CODE_HOME = NodePath.join(isolatedUserData, "t3");
  process.env.T3CODE_AGENT_HOMES_DIR = NodePath.join(isolatedUserData, "agents");
  process.env.T3CODE_DISABLE_AUTO_UPDATE = "1";
  Electron.app.setName(`${Electron.app.getName()}-isolated`);
  Electron.app.commandLine.appendSwitch("use-mock-keychain");
  if (Electron.app.dock) {
    Electron.app.setActivationPolicy("prohibited");
    Electron.app.dock.show = () => Promise.resolve();
  }
  for (const prototype of [Electron.BaseWindow.prototype, Electron.BrowserWindow.prototype]) {
    for (const method of HIDDEN_WINDOW_METHODS) prototype[method] = ignore;
  }
  Electron.app.on("web-contents-created", (_event, contents) => hideWebContents(contents));
  Electron.app.on("ready", denyPermissions);
  Electron.app.focus = ignore;
  Electron.app.show = ignore;
  Electron.dialog.showErrorBox = ignore;
  Electron.dialog.showMessageBox = (
    ...args: [Electron.BaseWindow, Electron.MessageBoxOptions] | [Electron.MessageBoxOptions]
  ) =>
    Promise.resolve({
      response: dismissedResponse(args.length === 2 ? args[1] : args[0]),
      checkboxChecked: false,
    });
  Electron.dialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] });
  Electron.shell.openExternal = () => Promise.resolve();
  Electron.shell.showItemInFolder = ignore;
  Electron.Notification.prototype.show = ignore;
  Electron.Menu.prototype.popup = (options) => options?.callback?.();
  Electron.clipboard.write = () => Promise.resolve();
  Electron.clipboard.writeText = () => Promise.resolve();
  Electron.clipboard.clear = ignore;
  Electron.systemPreferences.isTrustedAccessibilityClient = () => false;
  Electron.systemPreferences.askForMediaAccess = () => Promise.resolve(false);
  Electron.desktopCapturer.getSources = () => Promise.resolve([]);
  watchCaptureRequests(NodePath.join(isolatedUserData, "captures"));
}

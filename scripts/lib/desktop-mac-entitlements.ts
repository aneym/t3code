import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const MAC_HARDENED_RUNTIME_ENTITLEMENTS = `    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- The hardened runtime denies camera and microphone to the app and every
         child process, with no prompt, unless the app claims these. Terminals
         and coding agents inherit the app's TCC identity, so without these a
         command like ffmpeg or imagesnap gets silent access-denied. -->
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>`;

function renderMacHardenedRuntimeEntitlements(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
${MAC_HARDENED_RUNTIME_ENTITLEMENTS}
  </dict>
</plist>
`;
}

export const writeMacHardenedRuntimeEntitlements = Effect.fn("writeMacHardenedRuntimeEntitlements")(
  function* (entitlementsPath: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.log(
      "[desktop-artifact] T3CODE_MACOS_PROVISIONING_PROFILE is unset: signing with hardened runtime entitlements only; native passkeys are disabled.",
    );
    yield* fs.writeFileString(entitlementsPath, renderMacHardenedRuntimeEntitlements());
  },
);

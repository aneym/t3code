// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Include the major version, which Expo ignores, to prevent OTAs reaching older store binaries.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const version =
  process.env.T3CODE_MOBILE_VERSION ??
  appConfig.match(/^ {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? "([^"]+)"/m)?.[1];
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

/** @type {import("@expo/fingerprint").Config["fileHookTransform"]} */
const omitForkBuildStamp = (source, chunk) => {
  if (source.type !== "contents" || source.id !== "expoConfig" || typeof chunk !== "string") {
    return chunk;
  }
  const config = JSON.parse(chunk);
  if (config.extra?.forkBuild === undefined) return chunk;
  delete config.extra.forkBuild;
  return JSON.stringify(config);
};

module.exports = {
  nativeModuleSourceType: "files",
  extraSources: [{ type: "contents", id: "appMajorVersion", contents: majorVersion }],
  fileHookTransform: omitForkBuildStamp,
};

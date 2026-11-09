export const BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV = "T3CODE_SERVICE_ASSOCIATED_BUNDLE_IDS";
const associatedBundleIds = (process.env[BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV] ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
if (associatedBundleIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id))) {
  throw new Error(
    `${BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV} must be comma-separated bundle ids of letters, digits, dots or dashes.`,
  );
}
export const associatedBundleEnvironmentPlistLines =
  associatedBundleIds.length === 0
    ? []
    : [
        `    <key>${BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV}</key>`,
        `    <string>${associatedBundleIds.join(",")}</string>`,
      ];
export const associatedBundlePlistLines =
  associatedBundleIds.length === 0
    ? []
    : [
        `  <key>AssociatedBundleIdentifiers</key>`,
        `  <array>`,
        ...associatedBundleIds.map((id) => `    <string>${id}</string>`),
        `  </array>`,
      ];

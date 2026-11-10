export const BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV = "T3CODE_SERVICE_ASSOCIATED_BUNDLE_IDS";
const requestedBundleIds = (process.env[BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV] ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
const invalidBundleId = requestedBundleIds.find((id) => !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id));
export const associatedBundleIdsProblem =
  invalidBundleId === undefined
    ? undefined
    : `${BOOT_SERVICE_ASSOCIATED_BUNDLE_IDS_ENV} names "${invalidBundleId}"; use comma-separated bundle ids of letters, digits, dots or dashes.`;
const associatedBundleIds = invalidBundleId === undefined ? requestedBundleIds : [];
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

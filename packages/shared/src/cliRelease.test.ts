import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  cliReleaseRepositoryOf,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("keeps fork releases on the nightly channel and repository", () => {
    const version = "0.1.3-nightly.20261026.3726.aneym.1";
    expect(cliReleaseChannelOf(version)).toBe("nightly");
    expect(cliReleaseRepositoryOf(version)).toBe("aneym/t3code");
    expect(cliReleaseIndexPageUrl(1, version)).toBe(
      "https://api.github.com/repos/aneym/t3code/releases?per_page=100&page=1",
    );
    expect(cliReleaseDownloadBaseUrl(version)).toBe(
      "https://github.com/aneym/t3code/releases/download/v0.1.3-nightly.20261026.3726.aneym.1",
    );
    expect(cliReleaseChannelOf("0.1.3-nightly.20261026.3726")).toBe("nightly");
    expect(cliReleaseRepositoryOf("0.1.3-nightly.20261026.3726")).toBe("pingdotgg/t3code");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

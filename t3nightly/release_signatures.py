import argparse
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from contextlib import contextmanager
from pathlib import Path


TEAM = "89X6B853KW"
DESKTOP_ID = "com.t3tools.t3code"


def checked(words, refusal):
    try:
        result = subprocess.run(words, capture_output=True, text=True, timeout=240, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(refusal) from error
    if result.returncode:
        raise ValueError(refusal)
    return result.stdout + result.stderr


def verify_signature(path, identifier, desktop=False):
    requirement = f'identifier "{identifier}" and anchor apple generic and certificate leaf[subject.OU] = "{TEAM}"'
    requirement += ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    checked(["/usr/bin/codesign", "--verify", "--strict", "-R=" + requirement, str(path)], "signature identity or Developer ID requirement failed")
    detail = checked(["/usr/bin/codesign", "-dv", "--verbose=4", str(path)], "signature details unavailable")
    flags = re.search(r"flags=0x([0-9a-fA-F]+)", detail)
    if not flags or not int(flags[1], 16) & 0x10000:
        raise ValueError("signature lacks hardened runtime")
    assessment = checked(["/usr/sbin/spctl", "-a", "-vv", "-t", "execute" if desktop else "install", str(path)], "notarization assessment failed")
    if "source=Notarized Developer ID" not in assessment:
        raise ValueError("notarized Developer ID ticket is missing")
    if desktop:
        checked(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(path)], "nested app signature failed")
        checked(["/usr/bin/xcrun", "stapler", "validate", str(path)], "app notarization staple is missing or invalid")


def verify_cli(path):
    if sys.platform == "darwin":
        verify_signature(path, "t3")


def verify_desktop(path):
    verify_signature(path, DESKTOP_ID, desktop=True)


@contextmanager
def cli_binary(archive):
    with tempfile.TemporaryDirectory(prefix="t3nightly-cli-check-") as raw:
        target = Path(raw) / "t3"
        with tarfile.open(archive, "r:gz") as bundle:
            matches = [entry for entry in bundle.getmembers() if Path(entry.name).name == "t3" and entry.isfile()]
            if len(matches) != 1:
                raise ValueError("CLI archive must contain exactly one regular t3 binary")
            source = bundle.extractfile(matches[0])
            if source is None:
                raise ValueError("CLI binary cannot be read")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
        target.chmod(0o755)
        yield target


def verify_archive(archive):
    if re.search(r"-linux-(?:x64|arm64)\.tar\.gz$", Path(archive).name):
        return
    if re.search(r"-darwin-(?:x64|arm64)\.tar\.gz$", Path(archive).name) is None:
        raise ValueError("unrecognized CLI archive platform")
    with cli_binary(archive) as binary:
        verify_signature(binary, "t3")


def verify_desktop_zip(archive):
    with tempfile.TemporaryDirectory(prefix="t3nightly-app-check-") as raw:
        checked(["ditto", "-x", "-k", str(archive), raw], "desktop zip extraction failed")
        apps = list(Path(raw).glob("*.app"))
        if len(apps) != 1:
            raise ValueError("desktop zip must contain exactly one app")
        verify_desktop(apps[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("cli", "archive", "desktop", "desktop-zip"))
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        {"cli": verify_cli, "archive": verify_archive, "desktop": verify_desktop, "desktop-zip": verify_desktop_zip}[args.kind](args.path)
    except (OSError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f"signature refusal: {error}\n")


if __name__ == "__main__":
    sys.exit(main())

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from t3nightly.release_manifest import digest
from t3nightly.release_signatures import TEAM, cli_binary, verify_desktop, verify_signature

SCHEMA = "t3nightly.artifact-manifest/1"


def file_digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def tree_digest(root):
    result = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        result.update(relative.encode() + b"\0")
        if path.is_symlink():
            result.update(b"link\0" + os.readlink(path).encode() + b"\0")
        elif path.is_file():
            result.update(b"file\0" + str(path.stat().st_mode & 0o111).encode() + b"\0")
            result.update(bytes.fromhex(file_digest(path)) + b"\0")
        elif path.is_dir():
            result.update(b"dir\0")
        else:
            raise ValueError(f"unsupported desktop runtime entry: {relative}")
    return result.hexdigest()


def verification(platform_name, binary=None, app=None, local_adhoc=False):
    if platform_name != "darwin":
        return {
            "codesign": {"status": "not-applicable", "verified": False},
            "notarization": {"status": "not-applicable", "verified": False},
        }
    if local_adhoc:
        detail = subprocess.run(
            ["/usr/bin/codesign", "-dv", "--verbose=4", str(binary)],
            capture_output=True, text=True, check=False,
        )
        if detail.returncode or "Signature=adhoc" not in detail.stderr:
            raise ValueError("local CLI is not ad-hoc signed")
        return {
            "codesign": {"status": "ad-hoc", "verified": False},
            "notarization": {"status": "not-requested", "verified": False},
        }
    if app is not None:
        verify_desktop(app)
        return {
            "codesign": {"status": "developer-id", "team": TEAM, "verified": True},
            "notarization": {"status": "notarized-stapled", "verified": True},
        }
    verify_signature(binary, "t3")
    return {
        "codesign": {"status": "developer-id", "team": TEAM, "verified": True},
        "notarization": {"status": "notarized", "ticket": "online", "verified": True},
    }


def cli_manifest(archive, version, platform_name, arch, local_adhoc=False):
    with cli_binary(archive) as binary:
        runtime = {"kind": "executable", "entry": "t3", "sha256": file_digest(binary)}
        checks = verification(platform_name, binary=binary, local_adhoc=local_adhoc)
    return {
        "schema": SCHEMA,
        "kind": "cli",
        "release": version,
        "platform": platform_name,
        "arch": arch,
        "archive": {"name": archive.name, "bytes": archive.stat().st_size, "sha256": file_digest(archive)},
        "runtime": runtime,
        **checks,
    }


def desktop_manifest(archive, version, platform_name, arch):
    with tempfile.TemporaryDirectory(prefix="t3nightly-desktop-manifest-") as raw:
        subprocess.run(["ditto", "-x", "-k", str(archive), raw], check=True)
        apps = list(Path(raw).glob("*.app"))
        if len(apps) != 1:
            raise ValueError("desktop zip must contain exactly one app")
        app = apps[0]
        runtime = {"kind": "app-tree", "entry": app.name, "sha256": tree_digest(app)}
        checks = verification(platform_name, app=app)
    return {
        "schema": SCHEMA,
        "kind": "desktop",
        "release": version,
        "platform": platform_name,
        "arch": arch,
        "archive": {"name": archive.name, "bytes": archive.stat().st_size, "sha256": file_digest(archive)},
        "runtime": runtime,
        **checks,
    }


def write(out, value):
    value["digest"] = digest(value)
    prefix = "artifact" if value["kind"] == "cli" else "artifact-desktop"
    path = out / f"{prefix}-{value['platform']}-{value['arch']}.json"
    out.mkdir(parents=True, exist_ok=True)
    with path.open("x") as handle:
        json.dump(value, handle, sort_keys=True, indent=2)
        handle.write("\n")
    return path, value


def load(path):
    value = json.loads(path.read_text())
    if value.get("schema") != SCHEMA:
        raise ValueError("wrong artifact manifest schema")
    claimed = value.get("digest")
    body = {key: item for key, item in value.items() if key != "digest"}
    if not claimed or claimed != digest(body):
        raise ValueError("artifact manifest digest mismatch")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("cli", "desktop"))
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--arch", required=True)
    parser.add_argument("--local-adhoc", action="store_true")
    args = parser.parse_args()
    try:
        if args.kind == "cli":
            value = cli_manifest(args.archive.resolve(), args.version, args.platform, args.arch, args.local_adhoc)
        else:
            if args.local_adhoc:
                raise ValueError("desktop artifacts always require signing and notarization")
            value = desktop_manifest(args.archive.resolve(), args.version, args.platform, args.arch)
        path, value = write(args.out.resolve(), value)
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(1, f"artifact manifest refusal: {error}\n")
    print(json.dumps({"manifest": str(path), "digest": value["digest"], "archiveSha256": value["archive"]["sha256"], "runtimeSha256": value["runtime"]["sha256"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

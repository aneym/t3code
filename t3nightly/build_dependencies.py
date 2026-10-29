import argparse
import fcntl
import hashlib
import json
import os
import platform as host_platform
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = "t3nightly.dependency-seed/1"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def manifests(tree):
    result = subprocess.run(
        ["git", "-C", str(tree), "ls-files", "*package.json", "pnpm-workspace.yaml", ".pnpmfile.cjs", "patches/**"],
        capture_output=True, text=True, check=True,
    )
    content = hashlib.sha256()
    for name in sorted(line for line in result.stdout.splitlines() if line and not line.startswith(".repos/")):
        path = tree / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        if path.name == "package.json":
            value = json.loads(data)
            value.pop("version", None)
            data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        content.update(name.encode() + b"\0" + hashlib.sha256(data).digest())
    return content.hexdigest()


def vite_plus_version(tree):
    text = (tree / "pnpm-workspace.yaml").read_text()
    match = re.search(r"^  vite-plus:\s*[\"']?([^\s\"']+)", text, re.MULTILINE)
    if not match:
        raise ValueError("vite-plus catalog version is missing")
    return match.group(1)


def identity(tree, node_version, platform_name, arch):
    platform_name = "darwin" if platform_name == "mac" else platform_name
    return {
        "lockfileSha256": hashlib.sha256((tree / "pnpm-lock.yaml").read_bytes()).hexdigest(),
        "manifestSha256": manifests(tree),
        "nodeVersion": node_version,
        "vitePlusVersion": vite_plus_version(tree),
        "platform": platform_name,
        "arch": arch,
    }


def seed_root():
    configured = os.environ.get("T3NIGHTLY_DEPENDENCY_SEEDS")
    if configured:
        return Path(configured).expanduser().resolve()
    if host_platform.system() == "Darwin":
        return Path("/Volumes/StudioExt/cache/t3nightly-dependency-seeds")
    return Path("/home/jobs/cache/t3nightly-dependency-seeds")


def package_dirs(tree):
    result = subprocess.run(
        ["git", "-C", str(tree), "ls-files", "*package.json"],
        capture_output=True, text=True, check=True,
    )
    names = [line for line in result.stdout.splitlines() if line and not line.startswith(".repos/")]
    return sorted({Path(name).parent for name in names} | {Path(".")})


def module_paths(tree):
    return [str(path / "node_modules") for path in package_dirs(tree) if (tree / path / "node_modules").is_dir()]


def valid_record(path, expected):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if data.get("schema") != SCHEMA or data.get("identity") != expected:
        return None
    if data.get("key") != digest(expected) or not data.get("modules"):
        return None
    return data


def write_record(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, sort_keys=True, indent=2) + "\n")


def result(key, final, data, reused, methods):
    return {
        "schema": SCHEMA,
        "key": key,
        "seed": str(final),
        "reused": reused,
        "modules": len(data["modules"]),
        "copyMethods": methods,
        "identity": data["identity"],
    }


def ensure(tree, node_version, platform_name, arch, install):
    tree = tree.resolve()
    expected = identity(tree, node_version, platform_name, arch)
    key = digest(expected)
    root = seed_root()
    final = root / key
    stamp = tree / "node_modules" / ".t3nightly-seed.json"
    data = valid_record(stamp, expected)
    if data is not None:
        return result(key, final, data, True, ["in-place"])
    root.mkdir(parents=True, exist_ok=True)
    with (root / (key + ".lock")).open("a") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        data = valid_record(stamp, expected)
        if data is not None:
            return result(key, final, data, True, ["in-place"])
        reused = valid_record(final / "seed.json", expected) is not None
        code = subprocess.run(install, cwd=tree, check=False).returncode
        if code:
            raise ValueError(f"dependency installation exited {code}")
        if identity(tree, node_version, platform_name, arch) != expected:
            raise ValueError("dependency identity changed during installation")
        paths = module_paths(tree)
        if "node_modules" not in paths:
            raise ValueError("dependency installation produced no root node_modules")
        data = {
            "schema": SCHEMA,
            "key": key,
            "identity": expected,
            "modules": paths,
        }
        write_record(final / "seed.json", data)
        write_record(stamp, data)
    return result(key, final, data, reused, ["pnpm-install"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree", type=Path, required=True)
    parser.add_argument("--node-version", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--arch", required=True)
    parser.add_argument("install", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    install = args.install[1:] if args.install[:1] == ["--"] else args.install
    if not install:
        parser.error("an install command is required")
    try:
        result_data = ensure(args.tree, args.node_version, args.platform, args.arch, install)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"dependency seed refusal: {error}\n")
    print(json.dumps(result_data, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())

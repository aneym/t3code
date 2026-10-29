import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
from pathlib import Path

from .release_assemble import PACKAGE_FILES

HOST = os.environ.get("T3NIGHTLY_WINDOWS_HOST", "pc")
ROOT = "C:/t3b/fast"
CONFIG = Path(os.environ.get("T3NIGHTLY_PUBLIC_CONFIG", Path.home() / ".config/t3nightly/public-config.env"))
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+\.[0-9]+\.aneym\.[0-9]+")
SECRET_KEY = re.compile(r"TOKEN|SECRET|KEY|AUTH|HEADERS|PASSWORD", re.IGNORECASE)


def ssh_words(remote):
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", HOST, remote]


def secrets():
    if not CONFIG.is_file():
        return []
    values = []
    for line in CONFIG.read_text().splitlines():
        key, _, value = line.partition("=")
        if SECRET_KEY.search(key) and len(value.strip()) >= 6:
            values.append(value.strip().strip("'\""))
    return sorted(set(values), key=len, reverse=True)


def stream(words, log):
    hidden = secrets()
    log.write("$ " + " ".join(words[:5]) + " ...\n")
    log.flush()
    process = subprocess.Popen(words, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    for line in process.stdout:
        for value in hidden:
            line = line.replace(value, "[redacted]")
        log.write(line)
    log.flush()
    return process.wait()


def source_tarball(tree, head, version, target):
    actual = subprocess.run(["git", "-C", str(tree), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if actual != head:
        raise RuntimeError(f"candidate tree is at {actual}, not {head}")
    archive = subprocess.run(["git", "-C", str(tree), "archive", "--format=tar", head], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as source, tarfile.open(target, "w:gz") as bundle:
        stamped = set(PACKAGE_FILES)
        for member in source.getmembers():
            if member.name in stamped:
                continue
            bundle.addfile(member, source.extractfile(member) if member.isfile() else None)
        for name in PACKAGE_FILES:
            value = json.loads((tree / name).read_text())
            value["version"] = version
            data = (json.dumps(value, indent=2) + "\n").encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o644
            bundle.addfile(info, io.BytesIO(data))


def windows_build(config, head, log):
    out = config.run / "desktop-win"
    shutil.rmtree(out, ignore_errors=True)
    stage = out / "stage"
    stage.mkdir(parents=True)
    tree = config.candidate_tree()
    source_tarball(tree, head, config.version, stage / "src.tgz")
    manifest = subprocess.run([str(config.tools / "fork-build-manifest"), config.version], cwd=tree, capture_output=True, text=True, check=True).stdout
    (stage / "fork-build.json").write_text(manifest)
    shutil.copy2(CONFIG, stage / "public-config.env")
    shutil.copy2(config.tools / "win-build.ps1", stage / "win-build.ps1")
    remote = f"{ROOT}/{config.number}"
    try:
        if stream(ssh_words(f"powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '{remote}' | Out-Null\""), log):
            return 1
        if stream(["scp", "-q", "-o", "BatchMode=yes", *[str(path) for path in sorted(stage.iterdir())], f"{HOST}:{remote}/"], log):
            return 1
    finally:
        (stage / "public-config.env").unlink(missing_ok=True)
    script = f"{remote}/win-build.ps1".replace("/", "\\")
    if stream(ssh_words(f"powershell -NoProfile -ExecutionPolicy Bypass -File {script} -Version {config.version} -Dir {remote.replace('/', chr(92))}"), log):
        return 1
    shutil.rmtree(stage, ignore_errors=True)
    if stream(["scp", "-q", "-r", "-o", "BatchMode=yes", f"{HOST}:{remote}/publish", str(out) + "/"], log):
        return 1
    windows_assets(out / "publish", config.version)
    return 0


def manifest_field(text, name):
    match = re.search(rf"^{name}:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", text, re.MULTILINE)
    if not match:
        raise ValueError(f"nightly.yml has no {name}")
    return match.group(1)


def windows_assets(directory, version):
    manifest = directory / "nightly.yml"
    text = manifest.read_text()
    if manifest_field(text, "version") != version:
        raise ValueError(f"windows feed does not match {version}")
    name = manifest_field(text, "path")
    expected = manifest_field(text, "sha512")
    if not name.endswith(".exe") or "/" in name or "\\" in name:
        raise ValueError(f"unexpected windows installer path {name}")
    exe = directory / name
    if not exe.is_file():
        candidates = [path for path in directory.glob("*.exe") if version in path.name]
        if len(candidates) != 1:
            raise ValueError(f"windows installer {name} missing in {directory}")
        candidates[0].rename(exe)
        Path(f"{candidates[0]}.blockmap").rename(directory / f"{name}.blockmap")
    blockmap = directory / f"{name}.blockmap"
    if base64.b64encode(hashlib.file_digest(exe.open("rb"), "sha512").digest()).decode() != expected:
        raise ValueError("windows installer does not match nightly.yml sha512")
    if not blockmap.is_file():
        raise ValueError("windows installer blockmap missing")
    return [exe, blockmap, manifest]


def atomic_copy(source, target):
    temp = target.with_name(f".{target.name}.partial")
    shutil.copy2(source, temp)
    temp.chmod(0o644)
    os.replace(temp, target)


def version_key(version):
    return tuple(int(part) for part in re.findall(r"\d+", version))


def publish_windows(directory, version, feed):
    import fcntl

    assets = windows_assets(directory, version)
    with (feed / ".publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = feed / "releases.json"
        releases = json.loads(manifest.read_text())["releases"]
        row = next((entry for entry in releases if entry["version"] == version), None)
        if row is None:
            raise ValueError(f"{version} is not published to the feed; Windows ships only an approved release")
        target = feed / "desktop" / version
        target.mkdir(parents=True, exist_ok=True)
        for source in assets:
            atomic_copy(source, target / source.name)
        root = feed / "nightly.yml"
        current = manifest_field(root.read_text(), "version") if root.is_file() else None
        if current is None or version_key(version) >= version_key(current):
            for source in assets[:2]:
                atomic_copy(source, feed / source.name)
            atomic_copy(assets[2], root)
        row["desktop"] = sorted(set(row.get("desktop", [])) | {"win-x64"})
        temp = manifest.with_name(".releases.json.partial")
        temp.write_text(json.dumps({"releases": releases}, indent=2) + "\n")
        temp.chmod(0o644)
        os.replace(temp, manifest)
        live = manifest_field(root.read_text(), "path")
        kept = {entry["version"] for entry in releases}
        for path in [*feed.glob("*.exe"), *feed.glob("*.exe.blockmap")]:
            found = VERSION.search(path.name)
            if path.name not in (live, f"{live}.blockmap") and found and found.group(0) not in kept:
                path.unlink()
    return {"published": version, "windows": assets[0].name, "live": live}

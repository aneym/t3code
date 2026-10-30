import base64
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import tarfile
from pathlib import Path

from .release_assemble import PACKAGE_FILES

WINDOWS_STAGES = ("W", "FW")
FEED = Path("/Volumes/StudioExt/t3nightly-feed")
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
    values = {value for key, value in public_config().items() if SECRET_KEY.search(key) and len(value) >= 6}
    return sorted(values, key=len, reverse=True)


def public_config():
    values = {}
    for line in CONFIG.read_text().splitlines():
        key, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and re.fullmatch(r"[A-Z0-9_]+", key):
            words = shlex.split(value, comments=True)
            values[key] = " ".join(words)
    return values


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


def git(repo, *words, **kwargs):
    return subprocess.run(["git", "-C", str(repo), *words], capture_output=True, check=True, **kwargs).stdout


def source_tarball(repo, head, version, target):
    archive = git(repo, "archive", "--format=tar", head)
    with tarfile.open(fileobj=io.BytesIO(archive)) as source, tarfile.open(target, "w:gz") as bundle:
        stamped = set(PACKAGE_FILES)
        for member in source.getmembers():
            if member.name in stamped:
                continue
            bundle.addfile(member, source.extractfile(member) if member.isfile() else None)
        for name in PACKAGE_FILES:
            value = json.loads(git(repo, "show", f"{head}:{name}"))
            value["version"] = version
            data = (json.dumps(value, indent=2) + "\n").encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o644
            bundle.addfile(info, io.BytesIO(data))


def build_manifest(config, head, scratch):
    common = Path(git(config.repo, "rev-parse", "--path-format=absolute", "--git-common-dir", text=True).strip())
    tag = f"v{config.nightly}"
    sha = git(config.repo, "rev-parse", f"{tag}^{{commit}}", text=True).strip()
    gitdir = scratch / "manifest.git"
    (gitdir / "objects/info").mkdir(parents=True)
    (gitdir / "refs/tags").mkdir(parents=True)
    (gitdir / "objects/info/alternates").write_text(f"{common / 'objects'}\n")
    (gitdir / "refs/tags" / tag).write_text(f"{sha}\n")
    (gitdir / "HEAD").write_text(f"{head}\n")
    env = {**os.environ, "GIT_DIR": str(gitdir)}
    try:
        return subprocess.run([str(config.tools / "fork-build-manifest"), config.version], cwd=scratch, env=env, capture_output=True, text=True, check=True).stdout
    finally:
        shutil.rmtree(gitdir, ignore_errors=True)


def windows_build(config, head, log):
    out = config.run / "desktop-win"
    shutil.rmtree(out, ignore_errors=True)
    stage = out / "stage"
    stage.mkdir(parents=True)
    source_tarball(config.repo, head, config.version, stage / "src.tgz")
    (stage / "fork-build.json").write_text(build_manifest(config, head, out))
    target = stage / "public-config.json"
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
        json.dump(public_config(), handle)
    shutil.copy2(config.tools / "win-build.ps1", stage / "win-build.ps1")
    remote = f"{ROOT}/{config.number}"
    try:
        if stream(ssh_words(f"powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '{remote}' | Out-Null\""), log):
            return 1
        if stream(["scp", "-q", "-o", "BatchMode=yes", *[str(path) for path in sorted(stage.iterdir())], f"{HOST}:{remote}/"], log):
            return 1
    finally:
        target.unlink(missing_ok=True)
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
    urls = re.findall(r"^\s*-\s*url:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", text, re.MULTILINE)
    hashes = re.findall(r"^\s+sha512:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", text, re.MULTILINE)
    if urls != [name] or hashes != [expected]:
        raise ValueError("nightly.yml files[] must list exactly the installer named by path, with the same sha512")
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
            found = re.fullmatch(rf"T3-Code-({VERSION.pattern})-x64\.exe(?:\.blockmap)?", path.name)
            if path.name not in (live, f"{live}.blockmap") and found and found.group(1) not in kept:
                path.unlink()
    return {"published": version, "windows": assets[0].name, "live": live}


def run_windows(stage, config, head, log):
    if stage == "W":
        return windows_build(config, head, log)
    try:
        log.write(json.dumps(publish_windows(config.run / "desktop-win/publish", config.version, FEED)) + "\n")
    except (OSError, ValueError, KeyError) as error:
        log.write(f"publish-windows: {error}\n")
        return 1
    return 0


def windows_output(stage, config):
    if stage == "W":
        return bool(windows_assets(config.run / "desktop-win/publish", config.version))
    rows = json.loads((FEED / "releases.json").read_text())["releases"]
    return any(row["version"] == config.version and "win-x64" in row.get("desktop", []) for row in rows)

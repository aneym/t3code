import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import tempfile
import time
from pathlib import Path

from .gate_proc import CheckFailed, run

CACHE_ROOT = Path.home() / ".t3nightly" / "gate-seed"
MAX_AGE = 6 * 60 * 60
LATEST_MAX_AGE = 3 * 24 * 60 * 60
IMPORTS = re.compile(
    r"^\s*(?:import|export)\s+[^;]*?\bfrom\s*[\"']([^\"'\n]+)[\"']|"
    r"^\s*import\s*[\"']([^\"'\n]+)[\"']|"
    r"\bimport\s*\(\s*[\"']([^\"'\n]+)[\"']",
    re.MULTILINE,
)


def seed_key(tree, run_key):
    tree = Path(tree).resolve()
    packages = {}
    for manifest in (tree / "packages").glob("*/package.json"):
        data = json.loads(manifest.read_text())
        packages[data["name"]] = (manifest, data.get("exports", {}))
    pending = [tree / "apps/server/scripts/migrate-dev-db.ts"]
    inputs = {
        tree / "package.json",
        tree / "apps/server/package.json",
        tree / "pnpm-lock.yaml",
    }
    visited = set()
    while pending:
        source = pending.pop().resolve()
        if source in visited:
            continue
        visited.add(source)
        inputs.add(source)
        for match in IMPORTS.finditer(source.read_text()):
            specifier = next(group for group in match.groups() if group is not None)
            if specifier.startswith("."):
                target = source.parent / specifier
            else:
                name = "/".join(specifier.split("/")[:2])
                if name not in packages:
                    continue
                manifest, exports = packages[name]
                inputs.add(manifest)
                subpath = "." + specifier[len(name) :]
                exported = exports.get(subpath)
                while isinstance(exported, dict):
                    exported = exported.get("import", exported.get("default"))
                if not isinstance(exported, str):
                    raise CheckFailed("cannot resolve seed dependency %s" % specifier)
                target = manifest.parent / exported
            if not target.is_file():
                candidates = [Path(str(target) + suffix) for suffix in (".ts", ".tsx")]
                if target.suffix == ".js":
                    candidates.insert(0, target.with_suffix(".ts"))
                candidates.append(target / "index.ts")
                target = next((path for path in candidates if path.is_file()), target)
            if not target.is_file() or not target.resolve().is_relative_to(tree):
                raise CheckFailed("cannot resolve seed dependency %s" % specifier)
            pending.append(target)
    digest = hashlib.sha256(("gate-seed-v2:projects=2:threads=3:run=%s\0" % run_key).encode())
    for path in sorted(inputs):
        digest.update(str(path.relative_to(tree)).encode() + b"\0")
        content = path.read_bytes()
        if path.name == "package.json":
            manifest = json.loads(content)
            manifest.pop("version", None)
            content = json.dumps(
                manifest, sort_keys=True, separators=(",", ":")
            ).encode()
        digest.update(hashlib.sha256(content).digest())
    return digest.hexdigest()


def seed_age(path):
    try:
        return time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return float("inf")


def cache_entries(root):
    entries = []
    for path in root.iterdir():
        if not re.fullmatch(r"[0-9a-f]{64}-[0-9]+", path.name):
            continue
        try:
            status = path.stat()
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(status.st_mode):
            entries.append((status.st_mtime, path))
    return [path for _, path in sorted(entries, reverse=True)]


def populate_home(ctx, deadline, build):
    started = time.monotonic()
    pinned_seed = os.environ.get("T3NIGHTLY_GATE_SEED")
    if pinned_seed == "latest":
        CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        pinned_seed = next(
            (
                str(path)
                for path in cache_entries(CACHE_ROOT)
                if (path / "userdata/statev2.sqlite").is_file()
                and (path / "seed.json").is_file()
                and 0 <= seed_age(path) < LATEST_MAX_AGE
            ),
            None,
        )
    if pinned_seed:
        entry = Path(pinned_seed).expanduser().resolve()
        database = entry / "userdata/statev2.sqlite"
        if not database.is_file() or not (entry / "seed.json").is_file():
            raise CheckFailed("explicit gate seed is incomplete: %s" % entry)
        destination = Path(ctx.home) / "userdata"
        destination.mkdir(parents=True, exist_ok=True)
        clone = "-c" if platform.system() == "Darwin" else "--reflink=auto"
        code, _ = run(["cp", clone, str(database), str(destination / "statev2.sqlite")], ctx.log("boot"), deadline)
        if code:
            raise CheckFailed("explicit gate seed copy exited %d" % code)
        with open(ctx.log("boot"), "a") as log:
            log.write("explicit seed cache %s in %.3fs\n" % (entry, time.monotonic() - started))
        return json.loads((entry / "seed.json").read_text())["live_bytes"]
    key = seed_key(ctx.tree, ctx.version)
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    with (CACHE_ROOT / "build.lock").open("a") as lock:
        while True:
            deadline.left()
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(min(0.1, deadline.left()))
        entry = next(
            (
                path
                for path in cache_entries(CACHE_ROOT)
                if path.name.startswith(key + "-")
                and 0 <= time.time() - path.stat().st_mtime < MAX_AGE
                and (path / "userdata/statev2.sqlite").is_file()
                and (path / "seed.json").is_file()
            ),
            None,
        )
        reused = entry is not None
        if entry is None:
            with tempfile.TemporaryDirectory(prefix=".build-", dir=CACHE_ROOT) as temp:
                home = Path(temp) / "home"
                live_bytes = build(ctx, home, deadline)
                (home / "seed.json").write_text(json.dumps({"live_bytes": live_bytes}))
                entry = CACHE_ROOT / (key + "-%d" % time.time_ns())
                os.rename(home, entry)
        else:
            live_bytes = json.loads((entry / "seed.json").read_text())["live_bytes"]
        others = [path for path in cache_entries(CACHE_ROOT) if path != entry]
        for older in others[1:]:
            shutil.rmtree(older)
        destination = Path(ctx.home) / "userdata"
        destination.mkdir(parents=True, exist_ok=True)
        clone = "-c" if platform.system() == "Darwin" else "--reflink=auto"
        code, _ = run(
            [
                "cp",
                clone,
                str(entry / "userdata/statev2.sqlite"),
                str(destination / "statev2.sqlite"),
            ],
            ctx.log("boot"),
            deadline,
        )
        if code != 0:
            raise CheckFailed("seed cache copy exited %d" % code)
    with open(ctx.log("boot"), "a") as log:
        log.write(
            "seed cache %s in %.3fs\n"
            % ("reused" if reused else "built", time.monotonic() - started)
        )
    return live_bytes

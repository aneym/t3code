import fcntl
import json
import os
import re
import shutil
import time
from pathlib import Path

from .hot_swap_retention import kib
from .rehearsal_storage import store_root

DIGEST = re.compile(r"[0-9a-f]{64}")
PUBLICATION_GRACE_S = 15 * 60


def home_references(run, root):
    references = set()
    home = run / "home"
    if not home.is_dir():
        return references
    if home.is_symlink():
        raise ValueError("retained rehearsal home is a symlink")
    refs = home / "runtime/rehearsal-runtime-refs.json"
    if refs.exists():
        if refs.is_symlink():
            raise ValueError("rehearsal runtime references must not be a symlink")
        for raw in json.loads(refs.read_text()).values():
            target = Path(raw).resolve()
            if target.parent != root or not DIGEST.fullmatch(target.name):
                raise ValueError("retained clone source escaped the shared store")
            references.add(target)
    for path in (home / "runtime").rglob("*"):
        if path.is_symlink():
            target = path.resolve()
            if target.is_relative_to(root):
                references.add(root / target.relative_to(root).parts[0])
    seed = home / "runtime/rehearsal-seed.json"
    storage = run / "evidence/storage.json"
    if seed.exists():
        value = json.loads(seed.read_text())
    elif storage.exists():
        value = json.loads(storage.read_text()).get("seed", {})
    else:
        return references
    snapshot = Path(value.get("snapshot", "/"))
    if snapshot.is_relative_to(root / "seeds"):
        references.add(snapshot)
    return references


def retain_references(root):
    references = set()
    for run in root.parent.iterdir():
        if not run.name.startswith("rehearsal-") or run.is_symlink() or not run.is_dir():
            continue
        reservation = run / ".rehearsal-active.lock"
        if reservation.exists():
            with reservation.open("a") as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError("an isolated rehearsal is still preparing or running")
        references |= home_references(run, root)
    return references


def removable(root, path):
    return (path.parent == root and DIGEST.fullmatch(path.name) and path.is_dir() or path.parent == root / "seeds" and path.suffix == ".sqlite" and DIGEST.fullmatch(path.stem)) and not path.is_symlink() and path.resolve().is_relative_to(root) and path.stat().st_uid == root.stat().st_uid


def recent(root, path):
    published = root / ".published" / path.name
    if published.is_symlink() or published.parent.is_symlink():
        raise ValueError("rehearsal publication metadata must not be a symlink")
    published_at = published.stat().st_mtime if published.exists() else path.stat().st_ctime
    return time.time() - published_at < PUBLICATION_GRACE_S


def remove(root, path):
    size = kib(path) * 1024
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    (root / ".published" / path.name).unlink(missing_ok=True)
    return size


def prune():
    root = store_root()
    report = {"deleted": [], "kib": 0, "recent": [], "publicationGraceSeconds": PUBLICATION_GRACE_S}
    with (root / ".store.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            references = retain_references(root)
        except (OSError, ValueError) as error:
            return {**report, "held": str(error)}
        candidates = [path for path in root.iterdir() if DIGEST.fullmatch(path.name) and path.is_dir()]
        seeds = root / "seeds"
        if seeds.is_dir() and not seeds.is_symlink():
            candidates.extend(path for path in seeds.iterdir() if path.suffix == ".sqlite" and DIGEST.fullmatch(path.stem))
        for path in candidates:
            if path in references or not removable(root, path):
                continue
            if recent(root, path):
                report["recent"].append(str(path))
                continue
            report["kib"] += remove(root, path) // 1024
            report["deleted"].append(str(path))
    return report


def release(candidates):
    root = store_root()
    report = {"deleted": [], "bytes": 0, "referenced": [], "pending": []}
    with (root / ".store.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pending = root / ".release-pending.json"
        if pending.is_symlink():
            raise ValueError("rehearsal store release list must not be a symlink")
        wanted = sorted({*json.loads(pending.read_text()), *map(str, candidates)} if pending.exists() else set(map(str, candidates)))
        try:
            references = retain_references(root)
        except (OSError, ValueError) as error:
            report["held"], waiting = str(error), wanted
        else:
            waiting = []
            for raw in wanted:
                path = Path(raw)
                if not path.exists() or not removable(root, path):
                    continue
                if path in references:
                    report["referenced"].append(raw)
                elif recent(root, path):
                    waiting.append(raw)
                else:
                    size = remove(root, path)
                    report["deleted"].append({"path": raw, "bytes": size})
                    report["bytes"] += size
        staged = pending.with_suffix(".next")
        staged.write_text(json.dumps(waiting) + "\n")
        os.replace(staged, pending)
        report["pending"] = waiting
    return report

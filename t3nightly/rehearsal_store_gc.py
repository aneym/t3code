import fcntl
import json
import re
import shutil
from pathlib import Path

from .rehearsal_storage import store_root

DIGEST = re.compile(r"[0-9a-f]{64}")


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
        home = run / "home"
        if not home.is_dir():
            continue
        if home.is_symlink():
            raise ValueError("retained rehearsal home is a symlink")
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
            continue
        snapshot = Path(value.get("snapshot", "/"))
        if snapshot.is_relative_to(root / "seeds"):
            references.add(snapshot)
    return references


def prune():
    root = store_root()
    report = {"deleted": [], "kib": 0}
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
        from .hot_swap_retention import kib

        for path in candidates:
            if path in references or path.is_symlink() or not path.resolve().is_relative_to(root) or path.stat().st_uid != root.stat().st_uid:
                continue
            size = kib(path)
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            report["deleted"].append(str(path))
            report["kib"] += size
    return report

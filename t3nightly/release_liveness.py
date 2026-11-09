import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from .release_jobs import TERMINAL
from .release_readiness import serving_version

RECENT_S = 2 * 3600
VERSION = re.compile(r"(\d+\.\d+\.\d+-nightly\.\d+\.\d+\.aneym\.\d+)(?:-attempt\d+)?")


def run_roots():
    roots = [Path.home() / ".t3nightly/runs", Path.home() / "t3nightly/runs"]
    return [root for root in roots if root.is_dir() and not root.is_symlink()]


def why_live(run):
    for directory in sorted(run.glob("jobs/*")):
        try:
            outcome = json.loads((directory / "status.json").read_text()).get("outcome")
        except FileNotFoundError:
            outcome = "submission-unknown" if (directory / "job.json").exists() else None
        except (OSError, ValueError, AttributeError):
            outcome = "unreadable"
        if outcome is not None and outcome not in TERMINAL:
            return f"job {directory.name} is {outcome}"
    if (run / "final-receipt.json").is_file():
        return None
    activity = [path.stat().st_mtime for path in (run / "timeline.jsonl", *run.glob("sandbox-*.json")) if path.is_file()]
    if activity and time.time() - max(activity) < RECENT_S:
        return f"coordinator wrote {run.name} within {RECENT_S // 3600} h and has no final receipt"
    return None


def live_runs():
    live = {}
    for root in run_roots():
        for release in root.iterdir():
            if not release.is_dir() or release.is_symlink():
                continue
            for run in (release, *sorted(release.glob("fast*"))):
                if run.is_dir() and not run.is_symlink() and (reason := why_live(run)):
                    live[run] = reason
    return live


def cited_sandboxes(live):
    cited = {}
    for run, reason in live.items():
        for plan in run.glob("sandbox-*.json"):
            try:
                value = json.loads(plan.read_text())
                home = Path(value["home"]).parent
            except (OSError, ValueError, KeyError, TypeError):
                continue
            for name in (home.name, Path(value.get("rollbackRoot") or f"{home}-rollback").name):
                cited[name] = f"{run}: {reason}"
    return cited


def current_file():
    return Path.home() / ".t3nightly/current-releases.json"


def record_current(cite):
    hosts = {host: version for host, version in cite.items() if isinstance(version, str) and VERSION.fullmatch(version)}
    if not hosts or not current_file().parent.is_dir():
        return
    staged = current_file().with_suffix(".next")
    staged.write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "hosts": hosts}, indent=2) + "\n")
    staged.replace(current_file())


def current_releases(cite=None):
    current = {}
    try:
        current.update(json.loads(current_file().read_text()).get("hosts", {}))
    except (OSError, ValueError, AttributeError):
        pass
    current.update(cite or {})
    if isinstance(local := serving_version(), str):
        current["this host"] = local
    releases = {match[1] for root in run_roots() for path in root.iterdir() if (match := VERSION.fullmatch(path.name))}
    for version in sorted(releases, key=lambda value: tuple(int(part) for part in re.findall(r"\d+", value)))[-2:]:
        current.setdefault(f"last two releases: {version}", version)
    return {host: version for host, version in current.items() if isinstance(version, str) and VERSION.fullmatch(version)}


def current_receipts(current):
    wanted, texts = set(current.values()), {}
    for root in run_roots():
        for release in root.iterdir():
            if (match := VERSION.fullmatch(release.name)) is None or match[1] not in wanted or release.is_symlink():
                continue
            for path in (*release.glob("receipts/*.json"), *release.glob("*/receipts/*.json")):
                try:
                    texts[path] = path.read_text(errors="replace")
                except OSError:
                    texts[path] = None
    return texts


def citing(texts, path):
    for receipt, text in texts.items():
        if text is None or Path(path).name in text:
            return receipt
    return None

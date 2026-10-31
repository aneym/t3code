import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from .install_offbox_reship import launch
from .install_restore_hold import ENGINES, RESHIP_PENDING, engine, flocked, sweep

UNIT = "t3nightly-restore-boot.service"


def systemctl(*words):
    result = subprocess.run(["systemctl", "--user", *words], capture_output=True, text=True, timeout=30, check=False)
    return result.stderr.strip()[-300:] if result.returncode else None


def ensure(run, directory):
    root = engine(directory)
    (directory / ENGINES / "boot").write_text(f"{root}\n")
    path = Path.home() / ".config/systemd/user" / UNIT
    text = (f"[Unit]\nDescription=t3nightly restore-copy holds and reships after boot\nAfter={run.service_label}\n\n[Service]\nType=oneshot\n"
            f"Environment=PYTHONPATH={root}\nWorkingDirectory={root}\nExecStart={sys.executable} -m t3nightly.install_restore_boot --stage {directory}\n\n"
            "[Install]\nWantedBy=default.target\n")
    errors = []
    try:
        if not path.is_file() or path.read_text() != text:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            errors.append(systemctl("daemon-reload"))
        errors.append(systemctl("enable", UNIT))
    except (OSError, subprocess.SubprocessError) as error:
        errors.append(f"{type(error).__name__}: {error}")
    errors = [error for error in errors if error]
    run.step("restore-boot-unit", unit=str(path), engine=str(root), errors=errors)
    return {"unit": str(path), "engine": str(root), "errors": errors}


def resume(directory):
    resumed = []
    for status in sorted(directory.glob("restore-*.sqlite.reship.json")):
        value = json.loads(status.read_text())
        if value["state"] not in (*RESHIP_PENDING, "unscheduled") or datetime.now(UTC) >= datetime.fromisoformat(value["capAt"]):
            continue
        with flocked(f"{value['copy']}.reship.lock") as free:
            if free:
                resumed.append({"status": str(status), "state": launch(status, {**value, "state": "scheduled"}, 60)["state"]})
    return resumed


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_restore_boot",
                                     description="After boot, re-evaluate every restore-copy hold (re-arming its timer) and relaunch unfinished reships.")
    parser.add_argument("--stage", type=Path, required=True)
    directory = parser.parse_args().stage
    if not directory.is_dir():
        return 0
    print(json.dumps({"holds": sweep(directory, force=True), "reships": resume(directory)}, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import argparse
import json
import os
import signal
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def identity(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "pgid=,lstart=,args="], capture_output=True, text=True, timeout=10, check=False)
    if result.returncode or not result.stdout.strip():
        return None
    fields = result.stdout.strip().split(None, 6)
    if len(fields) != 7:
        raise ValueError("cannot establish rehearsal waiter process identity")
    return {"pgid": int(fields[0]), "start": " ".join(fields[1:6]), "command": fields[6]}


def wait(home, records, seconds):
    home = home.resolve()
    records = records.resolve()
    if records.parent != home.parent or records.name != "gate-waiters" or not home.parent.name.startswith("rehearsal-"):
        raise ValueError("gate waiter requires its own isolated rehearsal run directory")
    records.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not home.is_dir() or (records / ".closed").exists():
        return 0
    if os.getpgrp() != os.getpid():
        os.setsid()
    pid = os.getpid()
    observed = identity(pid)
    if observed is None or observed["pgid"] != pid:
        raise ValueError("rehearsal waiter did not acquire its own process group")
    receipt = {"at": now(), "pid": pid, "pgid": pid, "home": str(home), "gate": str(home / "release-gate"), "identity": observed, "deadlineSeconds": seconds}
    path = records / (str(pid) + "-" + uuid.uuid4().hex + ".json")
    path.write_text(json.dumps(receipt) + "\n")
    deadline = time.monotonic() + seconds
    try:
        while home.is_dir() and not (home / "release-gate").exists() and not (records / ".closed").exists() and time.monotonic() < deadline:
            time.sleep(0.25)
        receipt["exitReason"] = "home-removed" if not home.is_dir() else "released" if (home / "release-gate").exists() else "closed" if (records / ".closed").exists() else "deadline"
        return 0 if receipt["exitReason"] == "released" else 1
    finally:
        receipt["finishedAt"] = now()
        path.write_text(json.dumps(receipt) + "\n")


def cleanup(home, records):
    records = Path(records)
    if not records.exists():
        return {"at": now(), "waiters": []}
    if records.is_symlink() or records.resolve().parent != Path(home).resolve().parent:
        raise ValueError("waiter cleanup receipt directory escaped its rehearsal run")
    (records / ".closed").touch()
    report = {"at": now(), "waiters": []}
    for path in sorted(records.glob("*.json")):
        if path.is_symlink():
            raise ValueError("waiter identity receipt cannot be a symlink")
        receipt = json.loads(path.read_text())
        pid, pgid = receipt["pid"], receipt["pgid"]
        if receipt["home"] != str(Path(home).resolve()) or not isinstance(pid, int) or pid <= 1 or pgid != pid or pgid == os.getpgrp():
            raise ValueError("refused unsafe rehearsal waiter process group")
        observed = identity(pid)
        row = {"pid": pid, "pgid": pgid, "identity": receipt["identity"]}
        if observed is None:
            row["outcome"] = "already-exited"
        elif observed != receipt["identity"]:
            raise ValueError("refused reused rehearsal waiter PID")
        else:
            os.killpg(pgid, signal.SIGTERM)
            deadline = time.monotonic() + 3
            while identity(pid) == observed and time.monotonic() < deadline:
                time.sleep(0.05)
            if identity(pid) == observed:
                os.killpg(pgid, signal.SIGKILL)
            row["outcome"] = "terminated-owned-group"
        report["waiters"].append(row)
    output = records.parent / "gate-waiter-cleanup.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--records", type=Path, required=True)
    parser.add_argument("--seconds", type=int, required=True)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 1200:
        parser.error("waiter deadline must be 1..1200 seconds")
    return wait(args.home, args.records, args.seconds)


if __name__ == "__main__":
    raise SystemExit(main())

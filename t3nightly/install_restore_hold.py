import argparse
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .install_storage import record_payload

HOLD_S = 7200
CAP_S = 86400
RESHIP_WAIT_S = 900
SCHEMA = "t3nightly.restore-hold/2"
SUFFIXES = ("", "-wal", "-shm", "-journal")
SIDECARS = (".hold.json", ".hold.json.lock", ".hold.json.next", ".reship.json", ".reship.json.next", ".reship.lock")
ENGINES = ".hold-engine"
COPY_LOCK = ".restore-copy.lock"
RESHIP_PENDING = ("scheduled", "running", "retrying", "unscheduled")


def now():
    return datetime.now(UTC)


def write(path, value):
    staged = Path(f"{path}.next")
    staged.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(staged, 0o600)
    os.replace(staged, path)


def record_path(copy):
    return Path(f"{copy}.hold.json")


def remove(path):
    freed = 0
    for suffix in SUFFIXES:
        part = Path(f"{path}{suffix}")
        if part.is_file() and not part.is_symlink():
            freed += part.stat().st_size
            part.unlink()
    return freed


def forget(copy):
    for suffix in SIDECARS:
        Path(f"{copy}{suffix}").unlink(missing_ok=True)


def engine(directory):
    source = Path(__file__).resolve().parent
    files = sorted([*source.glob("*.py"), source / "offbox-ssh"])
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.name.encode() + b"\0" + path.read_bytes())
    root = Path(directory) / ENGINES / digest.hexdigest()[:16]
    if not (root / ".complete").is_file():
        staged = root.with_name(f".{root.name}-{uuid.uuid4().hex[:8]}")
        (staged / "t3nightly").mkdir(parents=True, mode=0o700)
        for path in files:
            shutil.copy2(path, staged / "t3nightly" / path.name)
        (staged / ".complete").write_text("")
        shutil.rmtree(root, ignore_errors=True)
        os.replace(staged, root)
    return root


def create(run, copy, *, kind="pending", expect=None, cap_s=CAP_S):
    at = now()
    record = {"schema": SCHEMA, "copy": str(copy), "kind": kind, "version": run.args.version, "expect": expect, "service": run.service_label, "port": run.args.port,
              "home": str(run.home), "state": str(run.state), "receipt": str(run.state / f"restore-hold-{run.args.version}.json"), "installReceipt": None, "holdS": HOLD_S,
              "createdAt": at.isoformat(), "capAt": (at + timedelta(seconds=cap_s)).isoformat(), "dueAt": (at + timedelta(seconds=cap_s)).isoformat(),
              "engine": None, "unit": None, "outcome": "pending", "history": []}
    write(record_path(copy), record)
    return record


def arm(record, path, delay):
    delay = max(60, int(delay))
    root = engine(path.parent)
    unit = f"t3nightly-restore-hold-{uuid.uuid4().hex[:12]}"
    command = ["systemd-run", "--user", f"--unit={unit}", f"--on-active={delay}", "--timer-property=AccuracySec=1min", f"--setenv=PYTHONPATH={root}",
               f"--working-directory={root}", "--", sys.executable, "-m", "t3nightly.install_restore_hold", "--record", str(path)]
    record.update(engine=str(root), unit=unit, dueAt=(now() + timedelta(seconds=delay)).isoformat(), outcome="scheduled", reason=None)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        if result.returncode:
            record.update(outcome="unarmed", reason=f"systemd-run failed: {result.stderr.strip()[-300:]}")
    except (OSError, subprocess.SubprocessError) as error:
        record.update(outcome="unarmed", reason=f"systemd-run failed: {type(error).__name__}: {error}")
    return record


def schedule(run, local, install_receipt, outcome, serving):
    path = record_path(local["path"])
    record = json.loads(path.read_text()) if path.is_file() else create(run, local["path"])
    installed = outcome == "installed"
    expect = run.args.version if installed else (serving if serving not in ("unavailable", "unverified") else None)
    record.update(kind="installed" if installed else "recovery", expect=expect, installReceipt=str(install_receipt), bytes=local["bytes"])
    delay = HOLD_S if installed else (datetime.fromisoformat(record["capAt"]) - now()).total_seconds()
    arm(record, path, delay)
    record["history"].append({"at": now().isoformat(), "action": "scheduled", "kind": record["kind"], "dueAt": record["dueAt"], "outcome": record["outcome"]})
    write(path, record)
    write(Path(record["receipt"]), record)
    run.step("restore-hold", kind=record["kind"], unit=record["unit"], dueAt=record["dueAt"], capAt=record["capAt"], outcome=record["outcome"], record=str(path))
    return {"record": str(path), "receipt": record["receipt"], "kind": record["kind"], "unit": record["unit"], "dueAt": record["dueAt"], "capAt": record["capAt"], "outcome": record["outcome"]}


def process_age(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    started = int(fields[19]) / os.sysconf("SC_CLK_TCK")
    return float(Path("/proc/uptime").read_text().split()[0]) - started


def observe(record):
    reasons, observed = [], {}
    version, hold, home = record["version"], record["holdS"], Path(record["home"])
    shown = subprocess.run(["systemctl", "--user", "show", record["service"], "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestampMonotonic", "-p", "NRestarts"],
                           capture_output=True, text=True, timeout=30, check=False)
    service = dict(line.split("=", 1) for line in shown.stdout.splitlines() if "=" in line)
    entered = int(service.get("ActiveEnterTimestampMonotonic") or 0)
    observed["service"] = {**service, "activeSeconds": round(time.clock_gettime(time.CLOCK_MONOTONIC) - entered / 1e6) if entered else 0}
    if (service.get("ActiveState"), service.get("SubState")) != ("active", "running"):
        reasons.append(f"{record['service']} is {service.get('ActiveState')}/{service.get('SubState')}")
    if observed["service"]["activeSeconds"] < hold:
        reasons.append(f"{record['service']} active {observed['service']['activeSeconds']} s, under {hold} s")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{record['port']}/.well-known/t3/environment", timeout=5) as response:
            observed["serving"] = json.load(response).get("serverVersion")
    except (OSError, ValueError) as error:
        observed["serving"] = f"unavailable: {type(error).__name__}"
    if observed["serving"] != version:
        reasons.append(f"serving {observed['serving']}, not {version}")
    try:
        state = json.loads((home / "runtime/service-state.json").read_text())
        observed["launcher"] = {"activeVersion": state.get("activeVersion"), "update": state.get("update")}
        server = json.loads((home / "userdata/server-runtime.json").read_text())
        observed["serverPid"], observed["serverSeconds"] = server.get("pid"), round(process_age(server["pid"]))
    except (OSError, ValueError, KeyError, IndexError) as error:
        reasons.append(f"serving process unreadable: {type(error).__name__}")
    else:
        if observed["launcher"]["activeVersion"] != version or observed["launcher"]["update"]:
            reasons.append(f"launcher state {observed['launcher']} is not settled on {version}")
        if observed["serverSeconds"] < hold:
            reasons.append(f"server process {observed['serverPid']} up {observed['serverSeconds']} s, under {hold} s")
    try:
        install = json.loads(Path(record["installReceipt"]).read_text())
        observed["install"] = {"outcome": install.get("outcome"), "serving": install.get("servingRuntime", {}).get("version")}
    except (OSError, TypeError, ValueError) as error:
        observed["install"] = f"unreadable: {type(error).__name__}"
    if observed["install"] != {"outcome": "installed", "serving": version}:
        reasons.append(f"install receipt {observed['install']} is not an accepted install of {version}")
    return reasons, observed


@contextmanager
def flocked(path):
    with open(path, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def reshipping(copy, at, cap):
    status = Path(f"{copy}.reship.json")
    if not status.is_file():
        return False
    with flocked(f"{copy}.reship.lock") as free:
        if not free:
            return True
    try:
        return json.loads(status.read_text()).get("state") in RESHIP_PENDING and at < cap
    except ValueError:
        return False


def decide(record, reasons, observed, at):
    cap = datetime.fromisoformat(record["capAt"])
    remaining = (cap - at).total_seconds()
    if observed.get("reshipping"):
        return "rearm", RESHIP_WAIT_S
    if remaining <= 0:
        settled = observed["service"].get("ActiveState") == "active" and record["expect"] in (None, observed.get("serving"))
        if settled:
            return "delete", f"retention cap reached while {record['service']} is active on {observed.get('serving')}"
        return "keep", f"RETENTION CAP PASSED: {record['service']} is {observed['service'].get('ActiveState')} on {observed.get('serving')}, expected {record['expect']}; copy kept for a person"
    if record["kind"] != "installed":
        return "rearm", remaining
    if not reasons:
        return "delete", f"served {record['version']} continuously for {record['holdS']} s"
    up = min(observed["service"].get("activeSeconds", 0), observed.get("serverSeconds", 0)) if observed.get("serving") == record["version"] else 0
    return "rearm", min(max(record["holdS"] - up, 60), remaining)


def evaluate(path):
    path = Path(path)
    with flocked(f"{path}.lock") as free:
        if not free:
            return None
        record = json.loads(path.read_text())
        copy, at = Path(record["copy"]), now()
        if not copy.is_file():
            action, detail, reasons, observed = "missing", "copy is gone", [], {}
        else:
            reasons, observed = observe(record)
            observed["reshipping"] = reshipping(copy, at, datetime.fromisoformat(record["capAt"]))
            action, detail = decide(record, reasons, observed, at)
        entry = {"at": at.isoformat(), "action": action, "detail": detail, "reasons": reasons, "observed": observed}
        if action == "delete":
            entry["freedBytes"] = remove(copy)
            record_payload(Path(record["state"]), "discard-restore-copy", copy, bytes=entry["freedBytes"])
            record["outcome"] = "deleted"
        elif action == "rearm":
            arm(record, path, detail)
            entry.update(dueAt=record["dueAt"], unit=record["unit"], armed=record["outcome"])
        elif action == "keep":
            arm(record, path, HOLD_S)
            record.update(outcome="kept-past-cap", loud=True)
            print(detail, file=sys.stderr, flush=True)
        else:
            record["outcome"] = "missing"
        record["history"].append(entry)
        write(Path(record["receipt"]), record)
        if record["outcome"] in ("deleted", "missing"):
            forget(copy)
        else:
            write(path, record)
        return record


def sweep(directory, *, force=False):
    actions = []
    for copy in sorted(directory.glob("restore-*.sqlite")):
        path = record_path(copy)
        if not path.is_file():
            actions.append({"copy": str(copy), "action": "leak-removed", "freedBytes": remove(copy)})
            forget(copy)
            continue
        try:
            due = datetime.fromisoformat(json.loads(path.read_text())["dueAt"]) <= now()
        except (KeyError, ValueError) as error:
            actions.append({"copy": str(copy), "action": "kept-unreadable-record", "error": str(error)})
            continue
        if due or force:
            record = evaluate(path)
            actions.append({"copy": str(copy), "action": "evaluated", "outcome": record and record["outcome"]})
    with flocked(directory / COPY_LOCK) as free:
        for part in sorted(directory.glob("restore-*.sqlite.part")):
            if not free:
                actions.append({"copy": str(part), "action": "kept-copy-in-progress"})
                continue
            actions.append({"copy": str(part), "action": "leak-removed", "freedBytes": remove(part)})
            forget(part.with_suffix(""))
        for path in sorted(directory.glob("restore-*.sqlite.hold.json")) if free else ():
            if not Path(str(path).removesuffix(".hold.json")).is_file():
                forget(Path(str(path).removesuffix(".hold.json")))
    boot = directory / ENGINES / "boot"
    live = {boot.read_text().strip()} if boot.is_file() else set()
    for path in [*directory.glob("restore-*.sqlite.hold.json"), *directory.glob("restore-*.sqlite.reship.json")]:
        try:
            live.add(json.loads(path.read_text()).get("engine"))
        except ValueError:
            return actions
    for root in (directory / ENGINES).glob("*") if (directory / ENGINES).is_dir() else ():
        if root != boot and str(root) not in live and not root.is_symlink():
            shutil.rmtree(root, ignore_errors=True)
    return actions


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_restore_hold",
                                     description="Evaluate a restore-copy hold record: delete the copy once its hold is met, re-arm while it is not yet met, and keep it loudly past the retention cap when the service is not on the expected version.")
    parser.add_argument("--record", type=Path, required=True)
    record = evaluate(parser.parse_args().record)
    print(json.dumps({"outcome": record and record["outcome"], "last": record and record["history"][-1]}, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

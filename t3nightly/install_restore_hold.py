import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .install_storage import record_payload

HOLD_S = 7200
SCHEMA = "t3nightly.restore-hold/1"
SUFFIXES = ("", "-wal", "-shm", "-journal")


def write(path, value):
    staged = Path(f"{path}.next")
    staged.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(staged, 0o600)
    os.replace(staged, path)


def schedule(run, record, install_receipt):
    version = run.args.version
    path = run.state / f"restore-hold-{version}.json"
    unit = f"t3nightly-restore-hold-{uuid.uuid4().hex[:12]}"
    root = Path(__file__).resolve().parent.parent
    command = [sys.executable, "-m", "t3nightly.install_restore_hold", "--copy", record["path"], "--version", version, "--service", run.service_label,
               "--port", str(run.args.port), "--home", str(run.home), "--install-receipt", str(install_receipt), "--receipt", str(path), "--hold-s", str(HOLD_S)]
    now = datetime.now(timezone.utc)
    hold = {"schema": SCHEMA, "copy": record["path"], "bytes": record["bytes"], "version": version, "unit": unit, "scheduledAt": now.isoformat(),
            "dueAt": (now + timedelta(seconds=HOLD_S)).isoformat(), "command": command, "outcome": "scheduled"}
    try:
        result = subprocess.run(["systemd-run", "--user", f"--unit={unit}", f"--on-active={HOLD_S}", "--timer-property=AccuracySec=1min",
                                 f"--setenv=PYTHONPATH={root}", f"--working-directory={root}", "--", *command], capture_output=True, text=True, timeout=30, check=False)
        if result.returncode:
            hold.update(outcome="kept", reason=f"systemd-run failed: {result.stderr.strip()[-300:]}")
    except (OSError, subprocess.SubprocessError) as error:
        hold.update(outcome="kept", reason=f"systemd-run failed: {type(error).__name__}: {error}")
    write(path, hold)
    run.step("restore-hold", unit=unit, dueAt=hold["dueAt"], outcome=hold["outcome"], receipt=str(path))
    return {"receipt": str(path), "unit": unit, "dueAt": hold["dueAt"], "outcome": hold["outcome"]}


def process_age(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    started = int(fields[19]) / os.sysconf("SC_CLK_TCK")
    return float(Path("/proc/uptime").read_text().split()[0]) - started


def held(args):
    reasons, observed = [], {}
    shown = subprocess.run(["systemctl", "--user", "show", args.service, "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestampMonotonic", "-p", "NRestarts"],
                           capture_output=True, text=True, timeout=30, check=False)
    service = dict(line.split("=", 1) for line in shown.stdout.splitlines() if "=" in line)
    entered = int(service.get("ActiveEnterTimestampMonotonic") or 0)
    observed["service"] = {**service, "activeSeconds": round(time.clock_gettime(time.CLOCK_MONOTONIC) - entered / 1e6) if entered else 0}
    if (service.get("ActiveState"), service.get("SubState")) != ("active", "running"):
        reasons.append(f"{args.service} is {service.get('ActiveState')}/{service.get('SubState')}")
    if observed["service"]["activeSeconds"] < args.hold_s:
        reasons.append(f"{args.service} active {observed['service']['activeSeconds']} s, under {args.hold_s} s")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/.well-known/t3/environment", timeout=5) as response:
            observed["serving"] = json.load(response).get("serverVersion")
    except (OSError, ValueError) as error:
        observed["serving"] = f"unavailable: {type(error).__name__}"
    if observed["serving"] != args.version:
        reasons.append(f"serving {observed['serving']}, not {args.version}")
    try:
        state = json.loads((args.home / "runtime/service-state.json").read_text())
        observed["launcher"] = {"activeVersion": state.get("activeVersion"), "update": state.get("update")}
        server = json.loads((args.home / "userdata/server-runtime.json").read_text())
        observed["serverPid"], observed["serverSeconds"] = server.get("pid"), round(process_age(server["pid"]))
    except (OSError, ValueError, KeyError, IndexError) as error:
        reasons.append(f"serving process unreadable: {type(error).__name__}")
    else:
        if observed["launcher"]["activeVersion"] != args.version or observed["launcher"]["update"]:
            reasons.append(f"launcher state {observed['launcher']} is not settled on {args.version}")
        if observed["serverSeconds"] < args.hold_s:
            reasons.append(f"server process {observed['serverPid']} up {observed['serverSeconds']} s, under {args.hold_s} s")
    try:
        install = json.loads(args.install_receipt.read_text())
        observed["install"] = {"outcome": install.get("outcome"), "serving": install.get("servingRuntime", {}).get("version")}
    except (OSError, ValueError) as error:
        observed["install"] = f"unreadable: {type(error).__name__}"
    if observed["install"] != {"outcome": "installed", "serving": args.version}:
        reasons.append(f"install receipt {observed['install']} is not an accepted install of {args.version}")
    return reasons, observed


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_restore_hold", description="Delete a restore-rollback copy only after the service has served this exact version continuously for the hold.")
    parser.add_argument("--copy", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--port", type=int, default=3773)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--install-receipt", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--hold-s", type=int, default=HOLD_S)
    args = parser.parse_args()
    hold = json.loads(args.receipt.read_text()) if args.receipt.is_file() else {"schema": SCHEMA, "copy": str(args.copy), "version": args.version}
    reasons, observed = held(args)
    freed = 0
    if not reasons:
        for suffix in SUFFIXES:
            part = Path(f"{args.copy}{suffix}")
            if part.is_file() and not part.is_symlink():
                freed += part.stat().st_size
                part.unlink()
        record_payload(args.receipt.parent, "discard-restore-copy", args.copy, bytes=freed)
    hold.update(outcome="kept" if reasons else "deleted", reasons=reasons, observed=observed, freedBytes=freed, checkedAt=datetime.now(timezone.utc).isoformat())
    write(args.receipt, hold)
    print(json.dumps({"outcome": hold["outcome"], "reasons": reasons}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

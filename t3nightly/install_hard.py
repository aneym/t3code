import json
import os
import plistlib
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .install_backup import capture
from .install_chat import identities, prove, retained
from .install_process import serving_process
from .install_provenance import file_digest, validate
from .install_runtime import pin_runtime, stage_runtime
from .release_receipts import INSTALL_SCHEMA, write
from .release_signatures import cli_binary

SERVICE_PROTOCOL = 3


def service(run, action):
    if sys.platform == "darwin":
        domain = f"gui/{os.getuid()}"
        command = ["launchctl", "bootout", "--wait", f"{domain}/{run.service_label}"] if action == "stop" else ["launchctl", "bootstrap", domain, str(run.service_plist)]
    else:
        command = ["systemctl", "--user", action, run.service_label]
    result = subprocess.run(command, capture_output=True, timeout=120, check=False)
    run.step("hard-service-" + action, service=run.service_label, code=result.returncode)
    if result.returncode:
        raise ValueError(f"intended service {action} failed")


def activate(run, version):
    launcher, backup = pin_runtime(run.home, version)
    if sys.platform == "darwin":
        with run.service_plist.open("rb") as handle:
            unit = plistlib.load(handle)
        unit["ProgramArguments"][0] = str(launcher)
        staged = run.service_plist.with_suffix(".next")
        staged.write_bytes(plistlib.dumps(unit))
        os.chmod(staged, 0o600)
        os.replace(staged, run.service_plist)
    else:
        dropin = Path(run.args.systemd_dropin).expanduser()
        dropin.mkdir(parents=True, exist_ok=True)
        override = dropin / "20-hard-runtime.conf"
        override.write_text(f'[Service]\nExecStart=\nExecStart="{launcher}" __service-launcher\n')
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, capture_output=True, timeout=30)
    state = run.home / "runtime/service-state.json"
    selected = json.loads(state.read_text()) if state.exists() else {"protocol": SERVICE_PROTOCOL}
    selected["activeVersion"] = version
    selected.pop("update", None)
    staged_state = state.with_suffix(".next")
    staged_state.write_text(json.dumps(selected) + "\n")
    os.chmod(staged_state, 0o600)
    os.replace(staged_state, state)
    service(run, "start")
    return launcher


def serving(run, version, expected):
    deadline = time.monotonic() + run.args.health_s
    while time.monotonic() < deadline:
        if run.server_version() == version:
            break
        time.sleep(0.5)
    else:
        raise ValueError("candidate serving version did not become healthy")
    serving_process(run, version, expected)


def advisory(run, backup):
    output = run.state / "backup-quick-check.json"
    log = run.state / "backup-quick-check.log"
    with log.open("ab") as handle:
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("install_backup.py")), backup["path"], str(output)], stdin=subprocess.DEVNULL, stdout=handle, stderr=handle, start_new_session=True)
    run.step("advisory-backup-check", pid=process.pid, output=str(output), log=str(log))


def install(run):
    args = run.args
    previous = run.server_version()
    if not previous:
        return run.finish("failed", "old server unavailable; nothing stopped")
    run.report["previous"] = previous
    target = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    archive = Path(args.assets) / f"t3-{args.version}-{target}.tar.gz"
    with cli_binary(archive) as candidate:
        manifest, rehearsal, host, observed = validate(run, previous, candidate)
    serving(run, previous, observed["oldRuntime.digest"])
    try:
        baseline = prove(run, previous)
    except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
        run.step("hard-baseline", outcome="environment-blocked", error=str(error))
        return run.finish("failed", "baseline environment-blocked; nothing stopped")
    before = identities(run)
    connect = run.connect_reachable(previous)
    backup = {}
    outcome = "failed"
    stopped = False
    post = baseline

    def stop():
        nonlocal stopped
        service(run, "stop")
        stopped = True

    try:
        if previous == args.version:
            serving(run, previous, observed["candidateRuntime.digest"])
            outcome = "current"
        else:
            staged = stage_runtime(run.home, args.version, args.assets)
            if file_digest(staged) != observed["candidateRuntime.digest"]:
                raise ValueError("staged candidate runtime changed after provenance check")
            backup = capture(run, previous, stop)
            activate(run, args.version)
            stopped = False
            serving(run, args.version, observed["candidateRuntime.digest"])
            retained(run, before)
            if connect and not run.connect_reachable(args.version):
                raise ValueError("previously healthy Connect is unavailable")
            post = prove(run, args.version, baseline)
            if not args.rehearsal:
                run.link_cli(args.version)
            outcome = "installed"
    except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
        run.step("hard-failure", error=str(error))
        if backup:
            try:
                if not stopped:
                    stop()
                activate(run, previous)
                stopped = False
                serving(run, previous, observed["oldRuntime.digest"])
                if not args.rehearsal:
                    run.link_cli(previous)
                outcome = "rolled-back"
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                run.step("hard-rollback-failed", error=str(rollback))
        elif stopped:
            try:
                service(run, "start")
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as restart:
                run.step("hard-restart-failed", error=str(restart))
    finally:
        if backup:
            try:
                advisory(run, backup)
            except (OSError, subprocess.SubprocessError) as error:
                run.step("advisory-backup-check-failed", error=str(error))
    moment = datetime.now(timezone.utc).isoformat()
    serving_version = run.server_version() or previous
    serving_binary = run.home / "runtime/launcher/t3"
    receipt = {
        "schema": INSTALL_SCHEMA, "release": args.version, "runId": uuid.uuid4().hex,
        "host": host, "platform": manifest["targets"][host]["platform"], "arch": manifest["targets"][host]["arch"],
        "candidateDigest": manifest["digest"], "rehearsalDigest": rehearsal["digest"] if rehearsal else "",
        "artifactManifestDigest": observed["artifactManifestDigest"], "service": run.service_label,
        "oldRuntime": {"version": previous, "digest": observed["oldRuntime.digest"]},
        "servingRuntime": {"version": serving_version, "digest": file_digest(serving_binary)},
        "backup": backup, "chat": post["proof"], "outcome": outcome,
        "startedAt": run.report["started_at"], "finishedAt": moment,
    }
    path = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    write(path, receipt)
    run.step("hard-install-receipt", path=str(path), outcome=outcome)
    return run.finish(outcome, f"hard install {outcome}: {previous} -> {args.version}")

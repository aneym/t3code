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

from .identity_snapshot import finish as finish_identities
from .install_backup import capture
from .install_chat import candidate_writes, identities, prove, retained
from .install_process import serving_process
from .install_strays import managed_strays, reap_strays
from .install_provenance import file_digest, migration_history, validate
from .install_runtime import pin_runtime, restore_runtime, retain_runtime, stage_runtime
from .release_receipts import INSTALL_SCHEMA, write
from .release_signatures import cli_binary

SERVICE_PROTOCOL = 3
CONNECT_WAIT_S = 120
CONNECT_POLL_S = 5


def service(run, action):
    from .install_policy import command_environment

    environment = command_environment(run)
    if sys.platform == "darwin":
        domain = f"gui/{os.getuid()}"
        commands = {"stop": ["launchctl", "bootout", "--wait", f"{domain}/{run.service_label}"],
                    "start": ["launchctl", "bootstrap", domain, str(run.service_plist)],
                    "restart": ["launchctl", "kickstart", "-k", f"{domain}/{run.service_label}"]}
        command = commands[action]
    else:
        command = ["systemctl", "--user", action, run.service_label]
    result = subprocess.run(command, env=environment, capture_output=True, timeout=120, check=False)
    run.step("hard-service-" + action, service=run.service_label, code=result.returncode)
    if result.returncode:
        raise ValueError(f"intended service {action} failed")


def activate(run, version):
    from .launcher_artifact import ensure_launcher

    launcher = ensure_launcher(run, version)
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
        from .install_policy import command_environment

        subprocess.run(["systemctl", "--user", "daemon-reload"], env=command_environment(run), check=True, capture_output=True, timeout=30)
    state = run.home / "runtime/service-state.json"
    selected = json.loads(state.read_text()) if state.exists() else {"protocol": SERVICE_PROTOCOL}
    selected["activeVersion"] = version
    selected.pop("update", None)
    staged_state = state.with_suffix(".next")
    staged_state.write_text(json.dumps(selected) + "\n")
    os.chmod(staged_state, 0o600)
    os.replace(staged_state, state)
    from .connector_artifact import ensure_connector

    ensure_connector(run)
    service(run, "start")
    from .launcher_artifact import watchdog

    watchdog(run, version)
    return launcher


def stray_serving(run, version, expected):
    strays = managed_strays(run)
    if len(strays) != 1 or Path(strays[0]["argv"][0]).resolve() != run.runtime(version).resolve() or file_digest(run.runtime(version)) != expected:
        return False
    run.step("hard-serving-ssh-launch", pid=strays[0]["pid"], launchDir=strays[0]["launchDir"], version=version, digest=expected)
    return True


def precheck(run, version, expected):
    try:
        serving(run, version, expected, reap=False)
    except ValueError:
        if run.server_version() != version or not stray_serving(run, version, expected):
            raise


def connect_returns(run, version):
    binary = run.connect_binary(version)
    start = time.monotonic()
    end = start + CONNECT_WAIT_S
    while True:
        remaining = end - time.monotonic()
        if remaining <= 0:
            return False
        try:
            reachable = run.connect_reachable(version, timeout=remaining, binary=binary)
        except subprocess.TimeoutExpired:
            return False
        if reachable and time.monotonic() <= end:
            run.step("hard-connect", version=version, waitedSeconds=round(time.monotonic() - start, 1))
            return True
        time.sleep(max(0, min(CONNECT_POLL_S, end - time.monotonic())))


def serving(run, version, expected, reap=True):
    deadline = time.monotonic() + (run.args.health_s if reap else 10)
    attempts = 0
    while time.monotonic() < deadline:
        if reap and reap_strays(run, attempts):
            attempts += 1
            service(run, "restart")
            deadline = time.monotonic() + run.args.health_s
            continue
        if run.server_version() == version:
            try:
                serving_process(run, version, expected)
                return
            except ValueError as error:
                if str(error) != "endpoint listener does not belong to intended service":
                    raise
        time.sleep(0.5)
    raise ValueError("candidate serving version did not become healthy")


def advisory(run, backup):
    output = run.state / "backup-quick-check.json"
    log = run.state / "backup-quick-check.log"
    with log.open("ab") as handle:
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("install_backup.py")), backup["path"], str(output)], stdin=subprocess.DEVNULL, stdout=handle, stderr=handle, start_new_session=True)
    run.step("advisory-backup-check", pid=process.pid, output=str(output), log=str(log))


def install(run):
    args = run.args
    run.reaped = []
    previous = run.server_version()
    if not previous:
        return run.finish("failed", "old server unavailable; nothing stopped")
    run.report["previous"] = previous
    target = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    archive = Path(args.assets) / f"t3-{args.version}-{target}.tar.gz"
    with cli_binary(archive) as candidate:
        manifest, rehearsal, host, observed = validate(run, previous, candidate)
    compatibility = manifest.get("compatibility", {})
    base_history = compatibility.get("baseMigrations", {}).get("history")

    def rollback_gate():
        live = migration_history(run)
        eligible = compatibility.get("binaryRollback") is True and ((compatibility.get("persistedState") == "compatible" and compatibility.get("migrationFiles") == []) or compatibility.get("persistedState") == "fork-additive") and live == base_history
        return {"liveMigrationHistory": live, "baseMigrationHistory": base_history} if eligible else None
    precheck(run, previous, observed["oldRuntime.digest"])
    try:
        baseline = prove(run, previous)
    except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
        run.step("hard-baseline", outcome="environment-blocked", error=str(error))
        return run.finish("failed", "baseline environment-blocked; nothing stopped")
    before = identities(run)
    connect = run.managed_connect(previous)
    backup = {}
    outcome = "failed"
    stopped = False
    routed = False
    post = baseline

    def stop():
        nonlocal stopped
        from .install_policy import recheck

        recheck(run)
        drain = getattr(run, "drain_before_stop", None)
        run.drain_before_stop = None
        if drain:
            drain()
        service(run, "stop")
        stopped = True
        attempts = 0
        while reap_strays(run, attempts):
            attempts += 1

    try:
        from .launcher_artifact import changed

        if previous == args.version and not changed(run):
            precheck(run, previous, observed["candidateRuntime.digest"])
            outcome = "current"
        else:
            staged = run.runtime(previous) if previous == args.version else stage_runtime(run.home, args.version, args.assets)
            if file_digest(staged) != observed["candidateRuntime.digest"]:
                raise ValueError("staged candidate runtime changed after provenance check")
            run.step("hard-retain-runtime", version=previous, path=str(retain_runtime(run.home, previous, run.home / "runtime/.rollback-runtime")))
            backup = capture(run, previous, stop, rollback_gate)
            routed = True
            activate(run, args.version)
            stopped = False
            serving(run, args.version, observed["candidateRuntime.digest"])
            retained(run, before)
            if connect and not connect_returns(run, args.version):
                raise ValueError("previously healthy Connect is unavailable")
            if connect:
                serving(run, args.version, observed["candidateRuntime.digest"], reap=False)
            post = prove(run, args.version, baseline)
            if args.force_rollback:
                candidate_writes(run, args.version, post["proof"])
                raise ValueError("forced rehearsal rollback")
            if not args.rehearsal:
                run.link_cli(args.version)
            outcome = "installed"
    except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
        run.step("hard-failure", error=str(error))
        if routed:
            try:
                from .install_hot_swap import binary_compatible, supported, swap
                from .install_rpc import restart_session

                if not binary_compatible(manifest, migration_history(run)) or not supported(run.environment(), run):
                    raise ValueError("post-routing rollback requires a compatible hot swap; database preserved for forward repair")
                restore_runtime(run.home, previous, run.home / "runtime/.rollback-runtime")
                with restart_session(run, args.version) as bearer:
                    swap(run, bearer, previous, True)
                serving(run, previous, observed["oldRuntime.digest"])
                outcome = "rolled-back"
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                run.report["forwardRepairRequired"] = True
                run.step("forward-repair-required", error_type=type(rollback).__name__, database_preserved=True)
        elif backup:
            try:
                if not stopped:
                    try:
                        stop()
                    except (OSError, ValueError, subprocess.SubprocessError) as reaping:
                        if not stopped:
                            raise
                        run.step("hard-rollback-stop", error=str(reaping))
                from .launcher_artifact import rollback_launcher

                rollback_launcher(run)
                if restore_runtime(run.home, previous, run.home / "runtime/.rollback-runtime"):
                    run.step("hard-restore-runtime", version=previous)
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
                stopped = False
                serving(run, previous, observed["oldRuntime.digest"])
                outcome = "rolled-back"
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as restart:
                run.step("hard-restart-failed", error=str(restart))
    finally:
        if backup.get("path"):
            try:
                advisory(run, backup)
            except (OSError, subprocess.SubprocessError) as error:
                run.step("advisory-backup-check-failed", error=str(error))
    moment = datetime.now(timezone.utc).isoformat()
    serving_version = run.server_version() or "unavailable"
    serving_digest = ""
    try:
        expected_digest = observed["candidateRuntime.digest"] if serving_version == args.version else observed["oldRuntime.digest"]
        serving_digest = file_digest(serving_process(run, serving_version, expected_digest))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        run.step("hard-serving-unverified", error_type=type(error).__name__)
        outcome = "failed"
        serving_version = "unverified"
    receipt = {
        "schema": INSTALL_SCHEMA, "release": args.version, "runId": uuid.uuid4().hex,
        "host": host, "platform": manifest["targets"][host]["platform"], "arch": manifest["targets"][host]["arch"],
        "candidateDigest": manifest["digest"], "rehearsalDigest": rehearsal["digest"] if rehearsal else "",
        "artifactManifestDigest": observed["artifactManifestDigest"], "service": run.service_label,
        "oldRuntime": {"version": previous, "digest": observed["oldRuntime.digest"]},
        "servingRuntime": {"version": serving_version, "digest": serving_digest},
        "installWindow": run.report.get("installWindow"), "hotSwap": {**(run.report.get("hotSwap") or {}), "forwardRepairRequired": run.report.get("forwardRepairRequired", False)},
        "backup": backup, "chat": post["proof"], "outcome": outcome, "reapedSshLaunch": run.reaped,
        "startedAt": run.report["started_at"], "finishedAt": moment,
    }
    path = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    write(path, receipt)
    run.step("hard-install-receipt", path=str(path), outcome=outcome)
    if outcome in ("installed", "current"):
        finish_identities(args.version, home=run.home)
    return run.finish(outcome, f"hard install {outcome}: {previous} -> {args.version}")

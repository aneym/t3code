import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .identity_snapshot import finish as finish_identities
from . import install_offbox, install_predrain, install_rollback_retention, install_settings
from .install_restore_copy import RecoveryRequired
from .install_db_rollback import recovery_required
from .install_backup import advisory, capture
from .install_compact import UNSAFE, compact, served
from .install_chat import candidate_writes, identities, prove, retained
from .install_process import serving_process
from .install_service import service
from .install_strays import managed_strays, reap_strays
from .install_provenance import eligibility, file_digest, migration_history, validate
from .install_runtime import restore_runtime, retain_runtime, stage_runtime
from .release_eligibility import FORCED_ROLLBACK, RESTORE_CLASS, binary_rollback, restore_refusal
from .release_receipts import INSTALL_SCHEMA, write
from .release_signatures import cli_binary
from .service_launch import (
    capture as capture_service_launch,
    reload as reload_service,
    restore as restore_service_launch,
    verify_restored,
    write_launcher,
)

SERVICE_PROTOCOL = 3
CONNECT_WAIT_S = 120
CONNECT_POLL_S = 5


def activate(run, version, *, rollback=False):
    from .connector_artifact import ensure_connector, rollback_connector
    from .launcher_artifact import ensure_launcher

    sandbox = run.service_label.startswith(("t3-rehearsal-", "com.t3-rehearsal."))
    try:
        if rollback:
            try:
                rollback_connector(run)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                run.report["connectorRestore"] = {"outcome": "failed", "error": str(error)}
                run.step("connector-restore-failed", error=str(error))
        if rollback and not sandbox:
            launcher = restore_service_launch(run)
        else:
            launcher = run.home / "runtime/launcher/t3" if rollback else ensure_launcher(run, version)
            if sandbox:
                if launcher != run.home / "runtime/launcher/t3":
                    raise ValueError("sandbox renderer launcher path changed")
            else:
                write_launcher(run, launcher)
        state = run.home / "runtime/service-state.json"
        selected = json.loads(state.read_text()) if state.exists() else {"protocol": SERVICE_PROTOCOL}
        selected["activeVersion"] = version
        selected.pop("update", None)
        staged_state = state.with_suffix(".next")
        staged_state.write_text(json.dumps(selected) + "\n")
        os.chmod(staged_state, 0o600)
        os.replace(staged_state, state)
        if not rollback:
            ensure_connector(run)
        if rollback and not sandbox:
            verify_restored(run)
        service(run, "start")
        from .launcher_artifact import watchdog

        watchdog(run, version)
        return launcher
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        if rollback and not sandbox and getattr(run, "service_launch_restored", False):
            try:
                try:
                    reload_service(run)
                except (OSError, subprocess.SubprocessError) as error:
                    run.step("hard-restored-service-reload-failed", error=str(error))
                verify_restored(run)
                service(run, "start")
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                run.step("hard-restored-service-start-failed", error=str(error))
        raise


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
                if str(error) not in ("endpoint listener does not belong to intended service", "serving child has not published its runtime state"):
                    raise
        time.sleep(0.5)
    raise ValueError("candidate serving version did not become healthy")


def install(run):
    args = run.args
    install_settings.prepare(run)
    run.reaped = []
    previous = run.server_version()
    if not previous:
        return run.finish("failed", "old server unavailable; nothing stopped")
    run.report["previous"] = previous
    target = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    archive = Path(args.assets) / f"t3-{args.version}-{target}.tar.gz"
    with cli_binary(archive) as candidate:
        manifest, rehearsal, host, observed = validate(run, previous, candidate)
    compatibility = manifest["targets"][host]["compatibility"]
    base_history = compatibility.get("baseMigrations", {}).get("history")
    refusal = restore_refusal(compatibility, host, args)
    if refusal:
        return run.finish("failed", refusal)
    restore_class = compatibility.get("eligibility") == RESTORE_CLASS
    compacting = getattr(args, "compact_db", False)

    def rollback_gate():
        live = migration_history(run)
        eligible = binary_rollback(compatibility) and live == base_history and not compacting
        return {"liveMigrationHistory": live, "baseMigrationHistory": base_history} if eligible else None
    from .launcher_artifact import preflight_launcher

    try:
        capture_service_launch(run)
        current = preflight_launcher(run, current=previous == args.version and not compacting) == "current"
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
        return run.finish("failed", str(error) if str(error).endswith("nothing stopped") else f"{error}; nothing stopped")
    precheck(run, previous, observed["oldRuntime.digest"])
    try:
        baseline = prove(run, previous)
        migration_evidence = {"before": migration_history(run)}
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
    database_rollback = {}

    def stop():
        nonlocal stopped
        from .install_handoff import admit_stop
        from .install_policy import recheck

        recheck(run)
        drain = getattr(run, "drain_before_stop", None)
        run.drain_before_stop = None
        if drain:
            admit_stop(run, drain())
        install_settings.capture(run)
        service(run, "stop")
        stopped = True
        run.stopped_at = time.monotonic()
        run.stop_deadline = time.monotonic() + args.offbox_stop_s
        try:
            attempts = 0
            while reap_strays(run, attempts):
                attempts += 1
        finally:
            if getattr(run, "settings_rollback", False):
                install_settings.restore(run)

    try:
        if current:
            precheck(run, previous, observed["candidateRuntime.digest"])
            install_settings.current(run)
            outcome = "current"
        else:
            staged = run.runtime(previous) if previous == args.version else stage_runtime(run.home, args.version, args.assets)
            if file_digest(staged) != observed["candidateRuntime.digest"]:
                raise ValueError("staged candidate runtime changed after provenance check")
            run.step("hard-retain-runtime", version=previous, path=str(retain_runtime(run.home, previous, run.home / "runtime/.rollback-runtime")))
            install_rollback_retention.apply(run, previous, args.version)
            backup = install_offbox.capture(run, previous, stop, rollback_gate, keep_local=restore_class) if args.offbox else capture(run, previous, stop, rollback_gate, keep_local=restore_class)
            if restore_class and not backup.get("local") and not backup.get("stoppedShip"):
                raise ValueError("restore-rollback requires a verified local restore copy")
            compact(run, backup)
            install_settings.apply(run)
            stopped = False
            activate(run, args.version)
            serving(run, args.version, observed["candidateRuntime.digest"])
            served(run)
            install_predrain.after_restart(run, backup)
            routed = True
            migration_evidence["candidate"] = migration_history(run)
            if restore_class and migration_evidence["candidate"] != compatibility["candidateMigrations"]["history"]:
                raise ValueError("serving candidate migration history differs from manifest")
            if backup.get("method") == install_offbox.METHOD:
                install_offbox.prune_backup(run, backup)
            retained(run, before)
            if connect and not connect_returns(run, args.version):
                raise ValueError("previously healthy Connect is unavailable")
            if connect:
                serving(run, args.version, observed["candidateRuntime.digest"], reap=False)
            post = prove(run, args.version, baseline)
            if args.force_rollback:
                candidate_writes(run, args.version, post["proof"])
                raise ValueError(FORCED_ROLLBACK)
            if not args.rehearsal:
                run.link_cli(args.version)
            outcome = "installed"
    except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
        run.step("hard-failure", error=str(error))
        from .install_policy import begin_recovery

        begin_recovery(run)
        run.settings_rollback = True
        if stopped:
            install_settings.restore(run)
        if routed and not restore_class:
            try:
                from .launcher_update import binary_compatible, supported, swap
                from .install_rpc import restart_session

                if not binary_compatible(compatibility, migration_history(run)):
                    raise ValueError("post-routing rollback requires a compatible binary; database preserved for forward repair")
                if run.server_settings is None and supported(run.environment(), run):
                    restore_runtime(run.home, previous, run.home / "runtime/.rollback-runtime")
                    from .connector_artifact import rollback_connector

                    try:
                        rollback_connector(run)
                    except (OSError, ValueError, subprocess.SubprocessError) as error:
                        run.report["connectorRestore"] = {"outcome": "failed", "error": str(error)}
                        run.step("connector-restore-failed", error=str(error))
                    if not run.service_label.startswith(("t3-rehearsal-", "com.t3-rehearsal.")):
                        restore_service_launch(run)
                    with restart_session(run, args.version) as bearer:
                        swap(run, bearer, previous, True)
                else:
                    stop()
                    restore_runtime(run.home, previous, run.home / "runtime/.rollback-runtime")
                    from .launcher_artifact import rollback_launcher

                    rollback_launcher(run)
                    activate(run, previous, rollback=True)
                    stopped = False
                    run.step("hard-binary-rollback", method="maintenance", database_preserved=True)
                serving(run, previous, observed["oldRuntime.digest"])
                outcome = "rolled-back"
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                run.report["forwardRepairRequired"] = True
                run.step("forward-repair-required", error_type=type(rollback).__name__, database_preserved=True)
        elif backup:
            try:
                if getattr(error, "reason", None) in UNSAFE:
                    raise error
                if not stopped:
                    try:
                        stop()
                    except (OSError, ValueError, subprocess.SubprocessError) as reaping:
                        if not stopped:
                            raise
                        run.step("hard-rollback-stop", error=str(reaping))
                install_settings.restore(run)
                from .launcher_artifact import rollback_launcher

                rollback_launcher(run)
                if restore_class or backup.get("method") == install_offbox.METHOD:
                    from .install_db_rollback import rollback_database

                    database_rollback = rollback_database(run, backup, compatibility) or {}
                    migration_evidence["restored"] = migration_history(run)
                    if restore_class and migration_evidence["restored"] != migration_evidence["before"]:
                        raise ValueError("restored migration history differs from pre-install database")
                if restore_runtime(run.home, previous, run.home / "runtime/.rollback-runtime"):
                    run.step("hard-restore-runtime", version=previous)
                activate(run, previous, rollback=True)
                stopped = False
                serving(run, previous, observed["oldRuntime.digest"])
                if not args.rehearsal:
                    run.link_cli(previous)
                outcome = "rolled-back"
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                if isinstance(rollback, RecoveryRequired):
                    path = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
                    database_rollback = recovery_required(backup, run.db.resolve(), run.service_label, path, rollback)
                    outcome = "failed"
                    run.step("database-recovery-required", **database_rollback)
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
    if getattr(run, "handoff_check", None):
        run.handoff_check(outcome)
    install_predrain.finish(run, backup, stopped, database_rollback)
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
        **{key: run.report[key] for key in ("restartDrain", "restartHandoff", "connectorRestore", "databaseQuiescence", "databaseCompaction") if key in run.report},
        "retryable": any((run.report.get(key) or {}).get("retryable") is True for key in ("restartDrain", "databaseQuiescence")),
        "migrationHistory": migration_evidence, "databaseRollback": database_rollback,
        **install_settings.receipt(run),
        "serviceStops": run.report.get("serviceStops", []), "backup": backup, "chat": post["proof"], "outcome": outcome, "reapedSshLaunch": run.reaped,
        "startedAt": run.report["started_at"], "finishedAt": moment,
    }
    path = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    local = backup.get("local")
    if local and backup.get("method") == install_offbox.METHOD and Path(local["path"]).is_file():
        from .install_offbox_reship import start
        from .install_restore_boot import ensure
        from .install_restore_hold import schedule

        local = {**local, "hold": schedule(run, local, path, outcome, serving_version)}
        if backup.get("replica") == "deferred":
            local["reship"] = start(run, local, backup)
        local["boot"] = ensure(run, Path(local["path"]).parent)
    receipt["eligibility"] = eligibility(manifest, host, args, local)
    if outcome in ("installed", "current"):
        finish_identities(args.version, home=run.home)
    write(path, receipt)
    if outcome in ("installed", "current"):
        from .install_backup_retention import settle

        settle(run, backup.get("path"), path.parent)
    run.step("hard-install-receipt", path=str(path), outcome=outcome)
    return run.finish(outcome, f"hard install {outcome}: {previous} -> {args.version}")

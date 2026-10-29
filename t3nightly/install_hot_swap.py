import json
import sqlite3
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .install_chat import identities, prove, retained
from .install_copy import backup_database
from .install_hard import connect_returns, install as hard_install
from .install_provenance import file_digest, migration_history, validate
from .install_rpc import restart_rpc, restart_session
from .install_runtime import restore_runtime, retain_runtime, stage_runtime
from .install_seamless import prepare_with_drain
from .release_receipts import INSTALL_SCHEMA, write


def supported(environment, run=None):
    capabilities = (environment or {}).get("capabilities", {})
    from .launcher_artifact import ingress_qualified

    return capabilities.get("serverSelfUpdate") == "boot-service" and capabilities.get("serverHotSwap") is True and (ingress_qualified(run) if run is not None else True)


def mark_candidate(run, manifest, rehearsal):
    qualification = (rehearsal or {}).get("hotSwap", {}) if not run.args.rehearsal else manifest.get("hotSwap", {})
    measured = qualification.get("candidateMeasuredStartupMs")
    if not isinstance(measured, int) or measured <= 0:
        return False
    if not run.args.rehearsal and (qualification.get("status") != "hot-swap" or qualification.get("sequenceContinuity") is not True):
        return False
    config = json.loads((run.home / "runtime/launcher-config.json").read_text())
    if measured > config["measuredStartupMs"]:
        return False
    marker = {"protocol": 1, "maintenance": False, "migration": False, "measuredStartupMs": measured, "candidateDigest": manifest["digest"], "runtimeDigest": file_digest(run.runtime(run.args.version))}
    (run.runtime(run.args.version).parent / "hot-swap.json").write_text(json.dumps(marker) + "\n")
    return True


def wait_version(run, version, update_id=None):
    end = time.monotonic() + run.args.health_s + run.args.drain_s
    while time.monotonic() < end:
        environment = run.environment()
        state = json.loads((run.home / "runtime/service-state.json").read_text())
        update = state.get("update", {})
        if update_id and update.get("id") == update_id and update.get("status") in ("failed", "rolled-back"):
            raise ValueError("launcher rejected/rolled back this exact trial before routing")
        if environment and environment.get("serverVersion") == version:
            if update_id is None or (update.get("id") == update_id and update.get("status") == "committed" and state.get("activeVersion") == version):
                return
        time.sleep(0.25)
    raise ValueError("bounded hot-swap health/version/update-identity gate failed")


def swap(run, bearer, version, downgrade=False):
    from .install_policy import recheck

    recheck(run)
    result = restart_rpc(run, bearer, "update", {"targetVersion": version, "allowDowngrade": downgrade, "continueRunningThreads": True}, timeout=run.args.health_s)
    if result.get("targetVersion") != version or result.get("method") != "boot-service" or not result.get("updateId"):
        raise ValueError("self-update returned no exact launcher update identity")
    run.step("launcher-request-update", target=version, update_id=result["updateId"])
    run.report["hotSwap"]["rollbackUpdate" if downgrade else "update"] = result
    wait_version(run, version, result["updateId"])
    return result


def binary_compatible(manifest, history):
    compatibility = manifest["compatibility"]
    return compatibility.get("binaryRollback") is True and compatibility.get("persistedState") in ("compatible", "fork-additive") and history == compatibility["candidateMigrations"]["history"] and (compatibility.get("persistedState") == "fork-additive" or compatibility.get("migrationFiles") == [])


def install(run):
    args = run.args
    previous = run.server_version()
    if not previous:
        raise ValueError("running server unavailable; nothing changed")
    run.report["previous"] = previous
    candidate = run.runtime(previous) if previous == args.version else stage_runtime(run.home, args.version, args.assets)
    manifest, rehearsal, host, observed = validate(run, previous, candidate)
    if previous == args.version:
        return hard_install(run)
    from .launcher_artifact import changed, qualify

    qualification = qualify(run)
    maintenance = bool(changed(run) or manifest["compatibility"].get("migrationFiles") or manifest["compatibility"].get("maintenance") or manifest.get("maintenance"))
    available = supported(run.environment(), run) and qualification["qualified"] and not maintenance
    if available and not mark_candidate(run, manifest, rehearsal):
        available, maintenance = False, True
    run.report["hotSwap"] = {"supported": available, "method": "launcher-ipc" if available else "maintenance" if maintenance else "hot-swap-unsupported", "qualification": qualification}
    if not available:
        if not supported(run.environment(), run):
            run.step("hot-swap-unsupported", fallback="drain-then-hard-install")
        if maintenance:
            run.step("maintenance-required", fallback="drain-then-hard-install")
        with restart_session(run, previous) as bearer:
            epoch = f"t3nightly:{uuid.uuid4()}"
            try:
                run.drain_before_stop = lambda: prepare_with_drain(run, bearer, epoch)
                return hard_install(run)
            finally:
                try:
                    restart_rpc(run, bearer, "abort", {"epoch": epoch}, timeout=30)
                except (OSError, ValueError, subprocess.SubprocessError):
                    run.step("fallback-drain-abort-unavailable")
    from .connector_artifact import ensure_connector

    ensure_connector(run)
    baseline = prove(run, previous)
    before = identities(run)
    connect = run.managed_connect(previous)
    backup = backup_database(run, previous, preparing=True)
    store = run.home / "runtime/.rollback-runtime"
    retain_runtime(run.home, previous, store)
    outcome, post, update = "failed", baseline, None
    with restart_session(run, previous) as bearer:
        epoch = f"t3nightly:{uuid.uuid4()}"
        requested = False
        try:
            run.step("restart-drain-launcher", deadline_s=args.drain_s)
            requested = True
            update = swap(run, bearer, args.version)
            retained(run, before)
            if connect and not connect_returns(run, args.version):
                raise ValueError("managed T3 Connect link did not recover")
            post = prove(run, args.version, baseline)
            if args.force_rollback:
                raise ValueError("forced isolated acceptance failure")
            outcome = "installed"
        except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
            run.step("hot-swap-failure", error=str(error))
            if not requested:
                restart_rpc(run, bearer, "abort", {"epoch": epoch})
                raise
            restore_runtime(run.home, previous, store)
            try:
                if run.server_version() == previous:
                    wait_version(run, previous)
                    method = "launcher-automatic"
                elif binary_compatible(manifest, migration_history(run)) and supported(run.environment(), run):
                    swap(run, bearer, previous, True)
                    method = "launcher-ipc"
                else:
                    run.report["hotSwap"]["forwardRepairRequired"] = True
                    raise ValueError("acceptance failed after routing; incompatible binary rollback refused; current database preserved for forward repair")
                retained(run, before)
                if connect and not connect_returns(run, previous):
                    raise ValueError("rollback managed tunnel acceptance failed")
                prove(run, previous, baseline)
                run.report["hotSwap"]["rollback"] = method
                outcome = "rolled-back"
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                run.step("hot-swap-rollback-failed", error_type=type(rollback).__name__)
                outcome = "broken"
    serving_version = run.server_version() or "unavailable"
    serving_binary = run.runtime(serving_version)
    serving_digest = file_digest(serving_binary) if serving_binary.is_file() else ""
    receipt = {"schema": INSTALL_SCHEMA, "release": args.version, "runId": uuid.uuid4().hex, "host": host, **{key: manifest["targets"][host][key] for key in ("platform", "arch")}, "candidateDigest": manifest["digest"], "rehearsalDigest": rehearsal["digest"] if rehearsal else "", "artifactManifestDigest": observed["artifactManifestDigest"], "service": run.service_label, "oldRuntime": {"version": previous, "digest": observed["oldRuntime.digest"]}, "servingRuntime": {"version": serving_version, "digest": serving_digest}, "backup": {"path": str(backup)}, "chat": post["proof"], "outcome": "failed" if outcome == "broken" else outcome, "reapedSshLaunch": [], "hotSwap": {**run.report["hotSwap"], "update": update or run.report["hotSwap"].get("update")}, "installWindow": run.report.get("installWindow"), "startedAt": run.report["started_at"], "finishedAt": datetime.now(timezone.utc).isoformat()}
    destination = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    write(destination, receipt)
    if outcome == "installed" and not args.rehearsal:
        run.link_cli(args.version)
    return run.finish(outcome, f"hot-swap {outcome}: {previous} -> {args.version}")

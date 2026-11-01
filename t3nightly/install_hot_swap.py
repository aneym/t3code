import json
import math
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import install_offbox
from .install_chat import candidate_writes, identities, prove, retained
from .install_copy import backup_database
from .install_hard import connect_returns, install as hard_install
from .install_provenance import eligibility, file_digest, migration_history, validate
from .install_rpc import restart_rpc, restart_session
from .install_runtime import restore_runtime, retain_runtime, stage_runtime
from .install_seamless import prepare_with_drain
from .release_eligibility import RESTORE_CLASS, binary_rollback
from .release_receipts import INSTALL_SCHEMA, write


def supported(environment, run=None):
    capabilities = (environment or {}).get("capabilities", {})
    from .launcher_artifact import ingress_qualified

    return capabilities.get("serverSelfUpdate") == "boot-service" and capabilities.get("serverHotSwap") is True and (ingress_qualified(run) if run is not None else True)


def measure_candidate(sandbox, manifest):
    from .headless_env import pin_settings
    from .rehearsal_storage import seed_database
    from .rehearsal_waiter import identity

    version = manifest["version"]
    binary = stage_runtime(sandbox.home, version, sandbox.args.assets)
    root = sandbox.home / "snapshots"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="candidate-startup-", dir=root) as raw:
        home = Path(raw)
        (home / "userdata").mkdir()
        (home / "runtime/tmp").mkdir(parents=True)
        seed = seed_database(sandbox.args.seed, home / "userdata/statev2.sqlite")
        pin_settings(home / "userdata/settings.json", home / "runtime", sandbox.evidence / "security-refusals.log")
        with socket.socket() as endpoint:
            endpoint.bind(("127.0.0.1", 0))
            port = endpoint.getsockname()[1]
        from .install_policy import refuse_probe

        refuse_probe(home, port, sandbox.label)
        environment = {key: value.replace(str(sandbox.home), str(home)) for key, value in sandbox.service_environment().items()}
        environment["T3CODE_PORT"] = str(port)
        receipt = {"version": version, "candidateDigest": manifest["digest"], "runtimeDigest": file_digest(binary), "home": str(home), "port": port, "seed": seed, "candidateMeasuredStartupMs": None}
        evidence = sandbox.evidence / "candidate-startup.json"
        with (sandbox.evidence / "candidate-startup.log").open("w") as log:
            started = time.monotonic()
            process = subprocess.Popen([str(binary), "serve", "--base-dir", str(home), "--host", "127.0.0.1", "--port", str(port), "--no-browser"], env=environment, cwd=home, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                receipt.update(pid=process.pid, identity=identity(process.pid))
                evidence.write_text(json.dumps(receipt, indent=2) + "\n")
                while time.monotonic() - started < sandbox.args.health_s:
                    if process.poll() is not None:
                        raise ValueError("candidate startup measurement exited before serving")
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=1) as response:
                            served = json.load(response)
                        if served.get("serverVersion") == version:
                            receipt["candidateMeasuredStartupMs"] = max(1, math.ceil((time.monotonic() - started) * 1000))
                            break
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.05)
                if receipt["candidateMeasuredStartupMs"] is None:
                    raise ValueError("candidate startup measurement timed out before serving")
            finally:
                try:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=20)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=10)
                finally:
                    receipt["exitCode"] = process.poll()
                    evidence.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def mark_candidate(run, manifest, rehearsal, compatibility, observed):
    qualification = (rehearsal or {}).get("hotSwap") or {}
    if run.args.rehearsal:
        path = run.state.parent / "candidate-startup.json"
        qualification = json.loads(path.read_text()) if path.is_file() else {}
        if any(qualification.get(key) != value for key, value in {"version": run.args.version, "candidateDigest": manifest["digest"], "runtimeDigest": file_digest(run.runtime(run.args.version))}.items()):
            run.step("hot-swap-fallback", reason="candidate-startup-evidence-missing-or-mismatched")
            return False
    elif qualification.get("status") != "hot-swap" or qualification.get("sequenceContinuity") is not True:
        run.step("hot-swap-fallback", reason="rehearsal-not-hot-swap-or-sequence-discontinuous", rehearsal_status=qualification.get("status"))
        return False
    if not run.args.rehearsal:
        startup = qualification.get("startupMeasurement") or {}
        if startup.get("version") != run.args.version:
            run.step("hot-swap-fallback", reason="rehearsal-startup-version-mismatch")
            return False
        if startup.get("runtimeDigest") != observed["candidateRuntime.digest"]:
            run.step("hot-swap-fallback", reason="rehearsal-startup-runtime-digest-mismatch")
            return False
        if startup.get("candidateMeasuredStartupMs") != qualification.get("candidateMeasuredStartupMs"):
            run.step("hot-swap-fallback", reason="rehearsal-startup-measurement-mismatch")
            return False
    measured = qualification.get("candidateMeasuredStartupMs")
    if type(measured) is not int or measured <= 0:
        run.step("hot-swap-fallback", reason="candidate-startup-measurement-missing-or-invalid")
        return False
    config = json.loads((run.home / "runtime/launcher-config.json").read_text())
    if measured > config["measuredStartupMs"]:
        run.step("hot-swap-fallback", reason="candidate-startup-exceeds-launcher-budget", measured_ms=measured, budget_ms=config["measuredStartupMs"])
        return False
    run.step("hot-swap-candidate-qualified", measured_ms=measured, budget_ms=config["measuredStartupMs"])
    from .hot_swap_marker import write as write_marker

    write_marker(run, run.args.version, measured, manifest)
    previous_measured = qualification.get("previousMeasuredStartupMs")
    previous = run.report.get("previous")
    if compatibility.get("binaryRollback") is True and previous and isinstance(previous_measured, int) and 0 < previous_measured <= config["measuredStartupMs"]:
        write_marker(run, previous, previous_measured, manifest)
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
    from .install_policy import begin_recovery, recheck

    if downgrade:
        begin_recovery(run)
    recheck(run)
    result = restart_rpc(run, bearer, "update", {"targetVersion": version, "allowDowngrade": downgrade, "continueRunningThreads": True}, timeout=run.args.health_s)
    if result.get("targetVersion") != version or result.get("method") != "boot-service" or not result.get("updateId"):
        raise ValueError("self-update returned no exact launcher update identity")
    run.step("launcher-request-update", target=version, update_id=result["updateId"])
    run.report["hotSwap"]["rollbackUpdate" if downgrade else "update"] = result
    wait_version(run, version, result["updateId"])
    return result


def binary_compatible(compatibility, history):
    return binary_rollback(compatibility) and history == compatibility["candidateMigrations"]["history"]


def drain_then_hard(run, previous):
    with restart_session(run, previous) as bearer:
        epoch = f"t3nightly:{uuid.uuid4()}"
        try:
            run.drain_before_stop = lambda: prepare_with_drain(run, bearer, epoch)
            return hard_install(run)
        finally:
            run.drain_before_stop = None
            try:
                restart_rpc(run, bearer, "abort", {"epoch": epoch}, timeout=30)
            except (OSError, ValueError, subprocess.SubprocessError):
                run.step("fallback-drain-abort-unavailable")
                drain = run.report.get("restartDrain") or {}
                if drain.get("stopRefused"):
                    drain["abortFailed"] = True
                    (run.state / "last.json").write_text(json.dumps(run.report, indent=1))


def launcher_identity(run, version, expected):
    from .install_process import serving_process

    serving_process(run, version, expected)
    serving = run.report["steps"][-1]
    return {"servicePid": serving["servicePid"], "childPid": serving["pid"], **{name: file_digest(run.home / "runtime" / name) for name in ("launcher/t3", "launcher-pin.json", "launcher-config.json")}}


def clean_rollback(run, previous, expected, original):
    requested = run.report["hotSwap"].get("update") or {}
    state = json.loads((run.home / "runtime/service-state.json").read_text())
    update = state.get("update") or {}
    if not requested.get("updateId") or update.get("id") != requested["updateId"] or update.get("status") not in ("rolled-back", "failed") or update.get("fromVersion") != previous or update.get("targetVersion") != run.args.version or state.get("activeVersion") != previous:
        return None
    if any(word in str(update.get("reason", "")).lower() for word in ("watchdog", "last-known-good", "lkg")) or any(step["step"].startswith("launcher-watchdog") for step in run.report["steps"]):
        return None
    if launcher_identity(run, previous, expected) != original:
        return None
    with urllib.request.urlopen(f"http://127.0.0.1:{run.args.port}/api/health", timeout=5) as response:
        if response.status != 200:
            return None
    return update


def install(run):
    args = run.args
    previous = run.server_version()
    if not previous:
        raise ValueError("running server unavailable; nothing changed")
    run.report["previous"] = previous
    candidate = run.runtime(previous) if previous == args.version else stage_runtime(run.home, args.version, args.assets)
    manifest, rehearsal, host, observed = validate(run, previous, candidate)
    compatibility = manifest["targets"][host]["compatibility"]
    if previous == args.version:
        return hard_install(run)
    from .launcher_artifact import changed, qualify

    qualification = qualify(run)
    environment = run.environment()
    run.report["capabilities"] = (environment or {}).get("capabilities", {})
    run.report["environmentObserved"] = isinstance(environment, dict)
    reasons = [name for name, required in (("service-artifact-change", changed(run)), ("migration-files", compatibility.get("migrationFiles")), ("compatibility-maintenance", compatibility.get("maintenance")), ("manifest-maintenance", manifest.get("maintenance")), ("restore-rollback-class", compatibility.get("eligibility") == RESTORE_CLASS)) if required]
    maintenance = bool(reasons)
    available = supported(environment, run) and qualification["qualified"] and not maintenance
    if available and not mark_candidate(run, manifest, rehearsal, compatibility, observed):
        available, maintenance = False, True
    run.report["hotSwap"] = {"supported": available, "method": "launcher-ipc" if available else "maintenance" if maintenance else "hot-swap-unsupported", "qualification": qualification}
    if not available:
        if not supported(environment, run):
            run.step("hot-swap-unsupported", reason="server-capability-or-ingress-unsupported", fallback="drain-then-hard-install")
        if not qualification["qualified"]:
            run.step("hot-swap-fallback", reason="host-not-qualified", qualification=qualification)
        for reason in reasons:
            run.step("hot-swap-fallback", reason=reason)
        if maintenance:
            run.step("maintenance-required", fallback="drain-then-hard-install")
        return drain_then_hard(run, previous)
    from .connector_artifact import ensure_connector

    ensure_connector(run)
    baseline = prove(run, previous)
    before = identities(run)
    connect = run.managed_connect(previous)
    backup = install_offbox.live_backup(run, previous) if args.offbox else {"path": str(backup_database(run, previous, preparing=True))}
    store = run.home / "runtime/.rollback-runtime"
    retain_runtime(run.home, previous, store)
    original_launcher = launcher_identity(run, previous, observed["oldRuntime.digest"])
    outcome, post, update = "failed", baseline, None
    fallback = None
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
                candidate_writes(run, args.version, post["proof"])
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
                elif binary_compatible(compatibility, migration_history(run)) and supported(run.environment(), run):
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
                if method == "launcher-automatic":
                    fallback = clean_rollback(run, previous, observed["oldRuntime.digest"], original_launcher)
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                run.step("hot-swap-rollback-failed", error_type=type(rollback).__name__)
                outcome = "broken"
    if fallback is not None and outcome == "rolled-back":
        run.report["hotSwap"].update(method="maintenance", fallback="drain-then-hard-install", launcherRollback=fallback)
        run.step("hot-swap-rolled-back", update_id=fallback["id"], reason=fallback.get("reason", "unspecified"))
        run.step("hot-swap-fallback", reason="verified-launcher-rollback", fallback="drain-then-hard-install")
        return drain_then_hard(run, previous)
    serving_version = run.server_version() or "unavailable"
    serving_binary = run.runtime(serving_version)
    serving_digest = file_digest(serving_binary) if serving_binary.is_file() else ""
    receipt = {"schema": INSTALL_SCHEMA, "release": args.version, "runId": uuid.uuid4().hex, "host": host, **{key: manifest["targets"][host][key] for key in ("platform", "arch")}, "candidateDigest": manifest["digest"], "rehearsalDigest": rehearsal["digest"] if rehearsal else "", "artifactManifestDigest": observed["artifactManifestDigest"], "service": run.service_label, "oldRuntime": {"version": previous, "digest": observed["oldRuntime.digest"]}, "servingRuntime": {"version": serving_version, "digest": serving_digest}, "backup": backup, "chat": post["proof"], "outcome": "failed" if outcome == "broken" else outcome, "reapedSshLaunch": [], "hotSwap": {**run.report["hotSwap"], "update": update or run.report["hotSwap"].get("update")}, "installWindow": run.report.get("installWindow"), "eligibility": eligibility(manifest, host, args), "startedAt": run.report["started_at"], "finishedAt": datetime.now(timezone.utc).isoformat()}
    destination = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    write(destination, receipt)
    if outcome == "installed" and not args.rehearsal:
        run.link_cli(args.version)
    return run.finish(outcome, f"hot-swap {outcome}: {previous} -> {args.version}")

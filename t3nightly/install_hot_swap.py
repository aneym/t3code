import json
import math
import os
import platform
import re
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import install_offbox, install_settings
from .install_chat import candidate_writes, identities, prove, retained
from .install_copy import backup_database
from .install_hard import connect_returns, install as hard_install
from .install_provenance import eligibility, file_digest, validate
from .install_rpc import restart_rpc, restart_session
from .install_runtime import restore_runtime, retain_runtime, stage_runtime
from .install_seamless import drain_then_hard
from .install_trial_rollback import clean_rollback, launcher_identity, recover
from .launcher_update import supported, swap
from .release_eligibility import RESTORE_CLASS
from .release_receipts import INSTALL_SCHEMA, write


def measure_candidate(sandbox, manifest):
    baseline, samples = [], []
    for index in range(1, 4):
        baseline.append(measure_startup_sample(sandbox, manifest, f"baseline-{index}", binary=sandbox.old / "t3", version=sandbox.old.name))
        samples.append(measure_startup_sample(sandbox, manifest, index))
    measured = [sample["candidateMeasuredStartupMs"] for sample in samples]
    valid = all(type(value) is int for value in measured)
    receipt = {**samples[-1], "candidateMeasuredStartupMs": int(statistics.median(measured)) if valid else None, "samplesMs": measured, "aggregation": "median", "samples": samples}
    ready = [sample.get("acquireToReadyMs") for sample in samples]
    old_ready = [sample.get("acquireToReadyMs") for sample in baseline]
    admitted = lambda group: all(sample["idle"] or sample.get("busyAllowed") is True for sample in group)
    receipt.update(host=platform.node(), measuredAt=time.time(), idle=all(sample["idle"] for sample in samples), busyAllowed=admitted(samples) and not all(sample["idle"] for sample in samples),
                   acquireToReadyMs=int(statistics.median(ready)) if all(type(value) is int and value > 0 for value in ready) else None,
                   hostBaseline={"host": platform.node(), "runtimeDigest": file_digest(sandbox.old / "t3"), "idle": all(sample["idle"] for sample in baseline), "busyAllowed": admitted(baseline) and not all(sample["idle"] for sample in baseline),
                                 "acquireToReadyMs": int(statistics.median(old_ready)) if all(type(value) is int and value > 0 for value in old_ready) else None, "samples": baseline})
    (sandbox.evidence / "candidate-startup.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def measure_startup_sample(sandbox, manifest, index, *, binary=None, version=None):
    from .headless_env import pin_settings
    from .rehearsal_storage import seed_database
    from .rehearsal_waiter import identity

    version = version or manifest["version"]
    binary = binary or stage_runtime(sandbox.home, version, sandbox.args.assets)
    def load():
        if sys.platform == "linux":
            def ticks():
                values = [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
                return sum(values), values[3] + values[4]
            before = ticks()
            time.sleep(0.1)
            after = ticks()
            fraction = (after[1] - before[1]) / max(1, after[0] - before[0])
            return {"idleFraction": round(fraction, 3), "threshold": ">= 0.2"}, fraction >= 0.2
        load1 = os.getloadavg()[0]
        limit = max(1, (os.cpu_count() or 1) * 0.5)
        return {"load1": round(load1, 2), "threshold": f"<= {limit}"}, load1 <= limit
    def idle():
        return load()[1]
    busy_ok = getattr(sandbox.args, "startup_busy_ok", False) is True
    idle_deadline = time.monotonic() + getattr(sandbox.args, "startup_idle_s", 60)
    while not idle() and time.monotonic() < idle_deadline:
        time.sleep(0.5)
    host_load, idle_before = load()
    if not idle_before and not busy_ok:
        receipt = {"idle": False, "candidateMeasuredStartupMs": None, "acquireToReadyMs": None, "reason": "idle-wait-deadline", "hostLoad": host_load, "version": version, "candidateDigest": manifest["digest"], "runtimeDigest": file_digest(binary)}
        (sandbox.evidence / f"candidate-startup-{index}.json").write_text(json.dumps(receipt) + "\n")
        return receipt
    root = sandbox.home / "snapshots"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="candidate-startup-", dir=root, ignore_cleanup_errors=True) as raw:
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
        evidence = sandbox.evidence / f"candidate-startup-{index}.json"
        with (sandbox.evidence / f"candidate-startup-{index}.log").open("w") as log:
            started = time.monotonic()
            process = subprocess.Popen(["node", str(Path(__file__).with_name("startup_probe.mjs")), str(binary), str(home), version, str(port)], env=environment, cwd=home, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                receipt.update(pid=process.pid, identity=identity(process.pid))
                evidence.write_text(json.dumps(receipt, indent=2) + "\n")
                while time.monotonic() - started < sandbox.args.health_s:
                    if process.poll() is not None:
                        log.flush()
                        if process.returncode:
                            receipt["reason"] = "warm-startup-probe-unsupported-or-failed"
                            break
                        receipt["candidateMeasuredStartupMs"] = max(1, math.ceil((time.monotonic() - started) * 1000))
                        break
                    time.sleep(0.05)
                if receipt["candidateMeasuredStartupMs"] is None:
                    receipt.setdefault("reason", "startup-probe-timeout")
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
                    receipt["idle"] = idle_before
                    receipt["hostLoad"] = host_load
                    receipt["busyAllowed"] = busy_ok and not idle_before
                    receipt["sampling"] = "idle-at-probe-start" if idle_before else "busy-allowed-interleaved"
                    log.flush()
                    matches = re.findall(r'acquireToReadyMs[\"\s:=]+(\d+)', (sandbox.evidence / f"candidate-startup-{index}.log").read_text())
                    receipt["acquireToReadyMs"] = int(matches[-1]) if matches else None
                    evidence.write_text(json.dumps(receipt, indent=2) + "\n")
    receipt["cleanupLeftover"] = str(home) if home.exists() else None
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
    startup = qualification.get("startupMeasurement") or qualification
    baseline = startup.get("hostBaseline") or {}
    host = platform.node()
    measured = startup.get("acquireToReadyMs")
    budget = baseline.get("acquireToReadyMs")
    if startup.get("host") != host or baseline.get("host") != host or not (startup.get("idle") is True or startup.get("busyAllowed") is True) or not (baseline.get("idle") is True or baseline.get("busyAllowed") is True) or not 0 <= time.time() - startup.get("measuredAt", 0) <= 3600:
        run.step("hot-swap-fallback", reason="fresh-idle-host-startup-baseline-required")
        return False
    if baseline.get("runtimeDigest") != observed["oldRuntime.digest"]:
        run.step("hot-swap-fallback", reason="host-baseline-runtime-mismatch")
        return False
    if type(budget) is not int or budget <= 0:
        run.step("hot-swap-fallback", reason="host-ready-baseline-missing")
        return False
    if type(measured) is not int or measured <= 0:
        run.step("hot-swap-fallback", reason="candidate-startup-measurement-missing-or-invalid")
        return False
    config = json.loads((run.home / "runtime/launcher-config.json").read_text())
    baseline_samples = [sample.get("acquireToReadyMs") for sample in baseline.get("samples", [])]
    if len(baseline_samples) != 3 or any(type(value) is not int or value <= 0 for value in baseline_samples):
        run.step("hot-swap-fallback", reason="independent-host-baseline-samples-required")
        return False
    margin = min(max(math.ceil(budget * 0.15), 500, max(baseline_samples) - min(baseline_samples)), config["holdBudgetMs"])
    budget = min(budget + margin, config["holdBudgetMs"])
    if measured > budget:
        run.step("hot-swap-fallback", reason="candidate-startup-exceeds-launcher-budget", measured_ms=measured, budget_ms=budget)
        return False
    run.step("hot-swap-candidate-qualified", measured_ms=measured, budget_ms=budget)
    from .hot_swap_marker import write as write_marker

    write_marker(run, run.args.version, measured, manifest)
    previous_measured = baseline.get("acquireToReadyMs")
    previous = run.report.get("previous")
    if compatibility.get("binaryRollback") is True and previous and isinstance(previous_measured, int) and 0 < previous_measured <= budget:
        write_marker(run, previous, previous_measured, manifest)
    return True


def install(run):
    args = run.args
    install_settings.prepare(run, mode="live-after-swap")
    fallback_enabled = not args.rehearsal or (not args.force_rollback and getattr(args, "inject", "none") == "none")
    previous = run.server_version()
    if not previous:
        raise ValueError("running server unavailable; nothing changed")
    run.report["previous"] = previous
    candidate = run.runtime(previous) if previous == args.version else stage_runtime(run.home, args.version, args.assets)
    manifest, rehearsal, host, observed = validate(run, previous, candidate)
    compatibility = manifest["targets"][host]["compatibility"]
    if previous == args.version:
        return hard_install(run)
    from .launcher_artifact import changed, preflight_launcher
    from .launcher_qualify import qualify

    try:
        preflight_launcher(run)
    except ValueError as error:
        return run.finish("failed", str(error))
    qualification = qualify(run)
    environment = run.environment()
    run.report["capabilities"] = (environment or {}).get("capabilities", {})
    run.report["environmentObserved"] = isinstance(environment, dict)
    reasons = [name for name, required in (("service-artifact-change", changed(run)), ("migration-files", compatibility.get("migrationFiles")), ("compatibility-maintenance", compatibility.get("maintenance")), ("manifest-maintenance", manifest.get("maintenance")), ("restore-rollback-class", compatibility.get("eligibility") == RESTORE_CLASS), ("offbox-stopped-ship", args.offbox_stopped_ship), ("compact-db", args.compact_db)) if required]
    maintenance = bool(reasons)
    available = supported(environment, run) and qualification["qualified"] and not maintenance
    if available and not mark_candidate(run, manifest, rehearsal, compatibility, observed):
        available, maintenance = False, True
    run.report["hotSwap"] = {"fallbackReasons": [step for step in run.report.get("steps", []) if step.get("step") == "hot-swap-fallback"], "supported": available, "method": "launcher-ipc" if available else "maintenance" if maintenance else "hot-swap-unsupported", "qualification": qualification}
    if not available:
        if not supported(environment, run):
            run.step("hot-swap-unsupported", reason="server-capability-or-ingress-unsupported", fallback="drain-then-hard-install")
        if not qualification["qualified"]:
            run.step("hot-swap-fallback", reason="host-not-qualified", qualification=qualification)
        for reason in reasons:
            run.step("hot-swap-fallback", reason=reason)
        if maintenance:
            run.step("maintenance-required", fallback="drain-then-hard-install")
        run.report["hotSwap"]["fallbackReasons"] = [step for step in run.report["steps"] if step.get("step") in ("hot-swap-fallback", "hot-swap-unsupported")]
        return drain_then_hard(run, previous)
    from .connector_artifact import ensure_connector

    ensure_connector(run)
    baseline = prove(run, previous)
    before = identities(run)
    connect = run.managed_connect(previous)
    backup = install_offbox.live_backup(run, previous) if args.offbox else {"path": str(backup_database(run, previous, preparing=True))}
    if run.report.get("backupMarkError"):
        backup["markError"] = run.report["backupMarkError"]
    store = run.home / "runtime/.rollback-runtime"
    retain_runtime(run.home, previous, store)
    try:
        original_launcher = launcher_identity(run, previous, observed["oldRuntime.digest"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        original_launcher = None
    outcome, post, update, fallback = "failed", baseline, None, None
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
            install_settings.live_after_swap(run)
            outcome = "installed"
            if args.force_rollback:
                candidate_writes(run, args.version, post["proof"])
                raise ValueError("forced isolated acceptance failure")
        except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
            run.step("hot-swap-failure", error=str(error))
            if not requested:
                restart_rpc(run, bearer, "abort", {"epoch": epoch})
                raise
            try:
                restore_runtime(run.home, previous, store)
                try:
                    fallback = clean_rollback(run, previous, observed["oldRuntime.digest"], original_launcher)
                    recover(run, bearer, previous, compatibility, before, connect, baseline)
                    outcome = "rolled-back"
                except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                    run.step("hot-swap-rollback-failed", error_type=type(rollback).__name__)
                    outcome = "broken"
                    run.report["hotSwap"].pop("rollback", None)
            finally:
                install_settings.restore(run)
    if fallback is not None and outcome == "rolled-back" and fallback_enabled and run.report["hotSwap"].get("rollback") == "launcher-automatic":
        if run.server_version() != previous:
            fallback = None
            try:
                with restart_session(run, previous) as bearer:
                    recover(run, bearer, previous, compatibility, before, connect, baseline)
            except (OSError, ValueError, sqlite3.Error, KeyError, subprocess.SubprocessError) as rollback:
                run.step("hot-swap-rollback-failed", error_type=type(rollback).__name__)
                outcome = "broken"
                run.report["hotSwap"].pop("rollback", None)
    if fallback is not None and outcome == "rolled-back" and fallback_enabled and run.report["hotSwap"].get("rollback") == "launcher-automatic":
        trial = run.report["hotSwap"].pop("rollback")
        run.report["hotSwap"].update(method="maintenance", fallback="drain-then-hard-install", trialRollback={**fallback, "method": trial})
        run.step("hot-swap-rolled-back", update_id=fallback["id"], reason=fallback.get("reason", "unspecified"))
        run.step("hot-swap-fallback", reason="verified-launcher-rollback", fallback="drain-then-hard-install")
        return drain_then_hard(run, previous)
    serving_version = run.server_version() or "unavailable"
    serving_binary = run.runtime(serving_version)
    serving_digest = file_digest(serving_binary) if serving_binary.is_file() else ""
    receipt = {"schema": INSTALL_SCHEMA, "release": args.version, "runId": uuid.uuid4().hex, "host": host, **{key: manifest["targets"][host][key] for key in ("platform", "arch")}, "candidateDigest": manifest["digest"], "rehearsalDigest": rehearsal["digest"] if rehearsal else "", "artifactManifestDigest": observed["artifactManifestDigest"], "service": run.service_label, "oldRuntime": {"version": previous, "digest": observed["oldRuntime.digest"]}, "servingRuntime": {"version": serving_version, "digest": serving_digest}, "backup": backup, "chat": post["proof"], "outcome": "failed" if outcome == "broken" else outcome, "reapedSshLaunch": [], "hotSwap": {**run.report["hotSwap"], "update": update or run.report["hotSwap"].get("update")}, "installWindow": run.report.get("installWindow"), "eligibility": eligibility(manifest, host, args), "startedAt": run.report["started_at"], "finishedAt": datetime.now(timezone.utc).isoformat()}
    destination = Path(args.install_receipt) if args.install_receipt else run.state / "receipts" / f"install-{host}.json"
    receipt.update(install_settings.receipt(run))
    destination.parent.mkdir(parents=True, exist_ok=True)
    write(destination, receipt)
    if outcome == "installed" and backup.get("path"):
        from .install_backup_retention import best_effort

        retention = best_effort(Path(backup["path"]).parent.parent, backup["path"], run.home)
        try:
            (destination.parent / "backup-retention.json").write_text(json.dumps(retention, indent=2) + "\n")
        except OSError as error:
            run.step("backup-retention-receipt-failed", error=str(error))
    if outcome == "installed" and not args.rehearsal:
        run.link_cli(args.version)
    return run.finish(outcome, f"hot-swap {outcome}: {previous} -> {args.version}")

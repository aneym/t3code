import json
import os
import subprocess
import time
import uuid
from datetime import datetime, timezone

from .install_bridge import capture_bridge
from .install_continuation import verify_dispositions
from .install_prepare import capture_work, prepare
from .install_rpc import restart_rpc, restart_session
from .install_status import verify_restart_status
from .install_resources import admission
from .install_reconcile import ReconcileError, imported_inventory, reconcile_import
from .install_handoff import startup_path as owned_startup_path, discard_owned


def write_receipt(path, value):
    staged = path.with_name(f".{path.name}.next")
    with staged.open("w") as handle:
        os.chmod(staged, 0o600)
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(staged, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def require_coverage(receipt, epoch, work):
    if receipt.get("ready") is not True or receipt.get("epoch") != epoch:
        raise ValueError("server did not prepare this restart epoch")
    covered = {}
    for thread in receipt["threads"]:
        for key in ("runIds", "queuedRunIds"):
            for run_id in thread[key]:
                if run_id in covered:
                    raise ValueError("server restart receipt repeats a run")
                covered[run_id] = thread["threadId"]
    for row in work:
        if covered.get(row["run_id"]) != row["thread_id"]:
            raise ValueError("server restart receipt does not cover all in-flight work")


def install(run):
    if not run.args.rpc_tree:
        raise ValueError("seamless installation requires --rpc-tree")
    previous = run.server_version()
    if previous is None:
        raise ValueError("server is not answering; seamless preparation refused")
    if run.merge_active() or run.held_locks():
        raise ValueError("release mutation lock is held; seamless preparation refused")
    connect_before = run.connect_reachable(previous)
    prepare(run)
    run.prepared_runtime = run.args.version
    prepared = json.loads((run.state / "prepared.json").read_text())
    epoch = f"t3nightly:{uuid.uuid4()}"
    receipt_path = run.state / "restart-handoff.json"
    run.report["previous"] = previous
    with restart_session(run, previous) as bearer:
        bridge = capture_bridge(run, epoch) if run.args.restart_source_bridge else None
        receipt = None
        captured = []
        startup_path = None
        status = None
        manifest = {
            "at": datetime.now(timezone.utc).isoformat(),
            "target": run.args.version,
            "previous": previous,
            "backup": prepared["backup"],
            "receipt": receipt,
            "bridge": bridge,
            "captured": captured,
            "swap_started": False,
        }
        try:
            if not bridge:
                receipt = restart_rpc(run, bearer, "prepare", {"epoch": epoch})
            admission(run, "before-short-swap")
            captured = capture_work(run)
            manifest.update(receipt=receipt, captured=captured)
            if receipt:
                require_coverage(receipt, epoch, captured)
            write_receipt(receipt_path, manifest)
            os.chmod(receipt_path, 0o600)
            if bridge:
                startup_path = owned_startup_path(run)
                write_receipt(startup_path, bridge)
            manifest["swap_started"] = True
            write_receipt(receipt_path, manifest)
            if not run.update(previous, run.args.version, False):
                raise ValueError("seamless runtime switch failed")
            problem = run.healthy(run.args.version, connect_before)
            if problem:
                raise ValueError(problem)
            if startup_path is not None and startup_path.exists():
                raise ValueError("replacement did not consume the startup handoff")
            if bridge:
                status = restart_rpc(
                    run, bearer, "status", {"epoch": epoch}, timeout=60
                )
                manifest["restart_status"] = status
                imported = {"epoch": epoch, "ready": True, "threads": []}
                try:
                    imported = imported_inventory(status, epoch, captured)
                    receipt = reconcile_import(run, imported, captured)
                except (OSError, ValueError, KeyError, TypeError) as error:
                    manifest["reconciled_handoff"] = (
                        error.handoff if isinstance(error, ReconcileError) else imported
                    )
                    if isinstance(error, ReconcileError):
                        manifest["persisted"] = error.persisted
                    try:
                        write_receipt(receipt_path, manifest)
                    except (OSError, KeyboardInterrupt) as receipt_error:
                        run.step(
                            "failure-receipt-write-failed", error=str(receipt_error)
                        )
                    raise
                manifest["reconciled_handoff"] = receipt
            end = time.monotonic() + run.args.health_s
            status_errors = 0
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise ValueError(
                        "source-linked restart continuations did not appear"
                    )
                try:
                    status = restart_rpc(
                        run,
                        bearer,
                        "status",
                        {"epoch": epoch},
                        timeout=min(60, remaining),
                    )
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    status_errors += 1
                    remaining = end - time.monotonic()
                    run.step(
                        "restart-status-retry",
                        attempt=status_errors,
                        error_type=type(error).__name__,
                    )
                    if remaining <= 0:
                        raise ValueError(
                            "restart status RPC persistently failed"
                        ) from error
                    time.sleep(min(2 ** (status_errors - 1), 4, remaining))
                    continue
                status_errors = 0
                manifest["restart_status"] = status
                try:
                    persisted = verify_dispositions(run, receipt, captured)
                    manifest["persisted"] = persisted
                    rpc_dispositions = verify_restart_status(
                        status, epoch, receipt, captured, persisted
                    )
                except (OSError, ValueError, KeyError, TypeError):
                    manifest["reconciled_handoff"] = receipt
                    try:
                        write_receipt(receipt_path, manifest)
                    except (OSError, KeyboardInterrupt) as receipt_error:
                        run.step(
                            "failure-receipt-write-failed", error=str(receipt_error)
                        )
                    raise
                dispositions = {
                    **rpc_dispositions,
                    "persisted": persisted,
                    "ready": rpc_dispositions["ready"] and persisted["ready"],
                }
                if dispositions["ready"]:
                    break
                if time.monotonic() >= end:
                    raise ValueError(
                        "source-linked restart continuations did not appear"
                    )
                time.sleep(1)
            manifest["dispositions"] = dispositions
            manifest["verified_at"] = datetime.now(timezone.utc).isoformat()
            write_receipt(receipt_path, manifest)
            run.link_cli(run.args.version)
            return run.finish(
                "installed",
                f"{run.report['host']}: {previous} -> {run.args.version} seamless switch verified; work and queues preserved",
            )
        except (Exception, KeyboardInterrupt) as error:
            try:
                discard_owned(run, startup_path, epoch)
            except (OSError, ValueError, KeyboardInterrupt) as discard_error:
                manifest["discard_error"] = str(discard_error)
                run.step(
                    "discard-owned-startup-handoff-failed", error=str(discard_error)
                )
            manifest["error"] = str(error)
            try:
                write_receipt(receipt_path, manifest)
            except (OSError, KeyboardInterrupt) as receipt_error:
                run.step("failure-receipt-write-failed", error=str(receipt_error))
            if not manifest["swap_started"]:
                if not bridge:
                    try:
                        restart_rpc(run, bearer, "abort", {"epoch": epoch})
                    except (
                        OSError,
                        ValueError,
                        subprocess.SubprocessError,
                    ) as abort_error:
                        run.step(
                            "restart-abort-failed",
                            error_type=type(abort_error).__name__,
                        )
                raise
            run.step("rollback", reason=str(error), database_restore=False)
            try:
                updated = run.update(run.args.version, previous, True)
                problem = (
                    run.healthy(previous, connect_before)
                    if updated
                    else "binary rollback failed"
                )
            except (
                OSError,
                ValueError,
                subprocess.SubprocessError,
                KeyboardInterrupt,
            ) as rollback_error:
                problem = f"binary rollback raised {type(rollback_error).__name__}"
            if problem is None:
                run.link_cli(previous)
                return run.finish(
                    "rolled-back-clean",
                    f"{run.report['host']}: seamless cutover failed; binary rollback preserved current database",
                )
            return run.finish(
                "broken",
                f"{run.report['host']}: seamless cutover and binary rollback failed; current database and prepared backup preserved",
            )

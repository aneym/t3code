import json
import subprocess
import uuid
from contextlib import ExitStack
from pathlib import Path

from .install_rpc import restart_rpc, restart_session
from .install_hard import install as hard_install


def prepare_with_drain(run, bearer, epoch):
    drain_s = run.args.drain_s
    if drain_s:
        run.step("restart-drain-start", deadline_s=drain_s)
    try:
        receipt = restart_rpc(
            run,
            bearer,
            "prepare",
            {"epoch": epoch, **({"drainTimeoutMs": drain_s * 1000} if drain_s else {})},
            timeout=drain_s + 120,
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise ValueError("restart drain RPC unavailable; nothing stopped") from error
    if drain_s == 0:
        return receipt
    drain = receipt.get("drain")
    if drain is None:
        run.report["restartDrain"] = {"outcome": "unreported", "deadlineS": drain_s}
        run.step("restart-drain-unreported", deadline_s=drain_s)
    else:
        run.report["restartDrain"] = {**drain, "deadlineS": drain_s, "outcome": "drained" if drain["drained"] else "timed-out"}
        run.step(
            "restart-drain",
            deadline_s=drain_s,
            drained=drain["drained"],
            waited_ms=drain["waitedMs"],
            active_run_ids=drain["activeRunIds"],
        )
    return receipt


def drain_then_hard(run, previous):
    if not run.args.rpc_tree or not Path(run.args.rpc_tree).expanduser().is_dir():
        raise ValueError("restart drain requires --rpc-tree with the frozen RPC dependency tree; nothing stopped")
    if not previous:
        return run.finish("failed", "old server unavailable; nothing stopped")
    with ExitStack() as stack:
        try:
            bearer = stack.enter_context(restart_session(run, previous))
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise ValueError("restart drain private installer session unavailable; nothing stopped") from error
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

import json
import subprocess
import time
import urllib.request

from .install_provenance import file_digest


def launcher_identity(run, version, expected):
    from .install_process import serving_process

    serving_process(run, version, expected)
    serving = run.report["steps"][-1]
    return {"servicePid": serving["servicePid"], **{name: file_digest(run.home / "runtime" / name) for name in ("launcher/t3", "launcher-pin.json", "launcher-config.json")}}


def clean_rollback(run, previous, expected, original):
    if original is None:
        return None
    deadline = time.monotonic() + min(3, run.args.health_s)
    while True:
        try:
            requested = run.report["hotSwap"].get("update") or {}
            path = run.home / "runtime/service-state.json"
            state = json.loads(path.read_text())
            update = state.get("update") or {}
            matches = requested.get("updateId") and update.get("id") == requested["updateId"] and update.get("status") in ("rolled-back", "failed") and update.get("fromVersion") == previous and update.get("targetVersion") == run.args.version
            excluded = any(word in str(update.get("reason", "")).lower() for word in ("watchdog", "last-known-good", "lkg")) or any(step["step"].startswith("launcher-watchdog") for step in run.report["steps"])
            if matches and not excluded and state.get("activeVersion") == previous and run.server_version() == previous:
                if launcher_identity(run, previous, expected) != original:
                    return None
                with urllib.request.urlopen(f"http://127.0.0.1:{run.args.port}/api/health", timeout=max(0.1, min(1, deadline - time.monotonic()))) as response:
                    if response.status == 200 and json.loads(path.read_text()) == state:
                        return update
        except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
            pass
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.1)


def recover(run, bearer, previous, compatibility, before, connect, baseline):
    from .install_chat import prove, retained
    from .install_hard import connect_returns
    from .install_hot_swap import binary_compatible, supported, swap, wait_version
    from .install_provenance import migration_history

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

import json
import time

from .install_rpc import restart_rpc
from .launcher_qualify import ingress_qualified
from .release_eligibility import binary_rollback


def supported(environment, run=None):
    capabilities = (environment or {}).get("capabilities", {})
    return capabilities.get("serverSelfUpdate") == "boot-service" and capabilities.get("serverHotSwap") is True and (ingress_qualified(run) if run is not None else True)


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

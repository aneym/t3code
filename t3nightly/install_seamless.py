from .install_rpc import restart_rpc


def prepare_with_drain(run, bearer, epoch):
    drain_s = run.args.drain_s
    if drain_s == 0:
        return restart_rpc(run, bearer, "prepare", {"epoch": epoch})
    run.step("restart-drain-start", deadline_s=drain_s)
    receipt = restart_rpc(
        run,
        bearer,
        "prepare",
        {"epoch": epoch, "drainTimeoutMs": drain_s * 1000},
        timeout=drain_s + 120,
    )
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

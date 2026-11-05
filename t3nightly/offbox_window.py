import time

SERVICE_TIMEOUT_S = 120
MARGIN_S = 120


def admit(run, stopped_work):
    window = run.args.offbox_window_s
    if not window:
        return
    overhead = run.args.drain_s + 4 * SERVICE_TIMEOUT_S + 2 * run.args.health_s + run.args.chat_timeout + MARGIN_S
    used = time.monotonic() - run.started_monotonic
    total = used + overhead + stopped_work
    run.step("hard-window-estimate", windowSeconds=window, usedSeconds=round(used, 3), overheadSeconds=overhead, stoppedWorkSeconds=round(stopped_work, 3), totalSeconds=round(total, 3))
    if total > window:
        raise ValueError(f"forward path plus rollback estimated at {total:.0f} s exceeds --offbox-window-s {window}; nothing stopped")

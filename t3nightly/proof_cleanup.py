import json
import math
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing

from .proof_archive import archive_idle, log_event


def threads(home):
    db = home / "userdata/statev2.sqlite"
    with closing(sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=2)) as connection:
        return {row[0] for row in connection.execute("SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL")}


def capture_baseline(home, log):
    try:
        return threads(home)
    except Exception as error:
        log_event(log, "proof-baseline-failed", errorType=type(error).__name__)
        return None


def cleanup(runtime, home, baseline, log):
    try:
        if baseline is None:
            return
        created = threads(home) - baseline
        if not created:
            return
        workers = min(16, len(created))
        budget = 20 / math.ceil(len(created) / workers)

        def archive_thread(thread_id):
            archive_idle(runtime, home, thread_id, log, deadline=time.monotonic() + budget, interrupt=True)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(archive_thread, sorted(created)))
    except Exception as error:
        log_event(log, "proof-archive-failed", errorType=type(error).__name__)


def check_log(ctx):
    def log(step, **fields):
        with open(ctx.log("proof-archive"), "a") as handle:
            handle.write(json.dumps({"step": step, **fields}) + "\n")
    return log


def baseline_checks(ctx):
    ctx.proof_baseline = capture_baseline(ctx.home, check_log(ctx))


def cleanup_checks(ctx):
    try:
        cleanup(ctx.t3, ctx.home, getattr(ctx, "proof_baseline", None), check_log(ctx))
    except Exception as error:
        log_event(check_log(ctx), "proof-archive-failed", errorType=type(error).__name__)


def rehearsal_log(step, **fields):
    print(json.dumps({"step": step, **fields}), flush=True)


def cleanup_rehearsal(sandbox, baseline):
    try:
        if baseline is not None:
            cleanup(sandbox.user_cli(), sandbox.home, baseline, rehearsal_log)
    except Exception as error:
        log_event(rehearsal_log, "proof-archive-failed", errorType=type(error).__name__)

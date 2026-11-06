import json
import sqlite3
from contextlib import closing

from .proof_archive import archive_idle


def threads(home):
    db = home / "userdata/statev2.sqlite"
    with closing(sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=10)) as connection:
        return {row[0] for row in connection.execute("SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL")}


def cleanup(runtime, home, baseline, log):
    try:
        created = threads(home) - baseline
        for thread_id in sorted(created):
            archive_idle(runtime, home, thread_id, log)
    except (OSError, sqlite3.Error) as error:
        log("proof-archive-failed", errorType=type(error).__name__)


def cleanup_checks(ctx):
    def log(step, **fields):
        line = json.dumps({"step": step, **fields})
        try:
            with open(ctx.log("proof-archive"), "a") as handle:
                handle.write(line + "\n")
        except OSError:
            print(line, flush=True)

    if hasattr(ctx, "proof_baseline"):
        cleanup(ctx.t3, ctx.home, ctx.proof_baseline, log)

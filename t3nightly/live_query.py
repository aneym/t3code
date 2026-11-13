import sqlite3
import time
from contextlib import closing

LIMIT_S = 5


def bounded(db, sql, params=(), seconds=LIMIT_S):
    deadline = time.monotonic() + seconds
    with closing(sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=seconds)) as connection:
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        return connection.execute(sql, params).fetchall()

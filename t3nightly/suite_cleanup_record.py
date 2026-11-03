import contextvars
import socket

from .release_jobs import write_status

_RECORD = contextvars.ContextVar("advisory_cleanup", default=None)


def worker_record(path, value):
    value["ownerHost"] = socket.gethostname()
    value["processGroups"] = []
    write_status(path, value)
    _RECORD.set((path, value))


def track_process(pgid):
    record = _RECORD.get()
    if record:
        path, value = record
        value["processGroups"].append(pgid)
        write_status(path, value)

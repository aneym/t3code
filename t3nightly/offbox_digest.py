import shlex
import sqlite3
import subprocess
import sys
import time
from contextlib import closing

from .install_sqlite_sync import SSH

CONTENT_PY = ("import hashlib,sys\n"
              "h=hashlib.sha256()\n"
              "with open(sys.argv[1],'rb') as f:\n"
              " b=bytearray(f.read(100)); b[24:28]=bytes(4); b[92:100]=bytes(8); h.update(b)\n"
              " for c in iter(lambda: f.read(1<<20), b''): h.update(c)\n"
              "print(h.hexdigest())")


def checkpoint(source):
    with closing(sqlite3.connect(source, timeout=30, isolation_level=None)) as connection:
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
            raise ValueError("stopped database checkpoint is busy; candidate not installed")


def compare(run, host, replica, source, deadline):
    started = time.monotonic()
    near = subprocess.Popen([sys.executable, "-I", "-c", CONTENT_PY, str(source)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    far = subprocess.Popen([str(SSH), host, f"python3 -I -c {shlex.quote(CONTENT_PY)} {shlex.quote(str(replica))}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        ours, _ = near.communicate(timeout=max(1, deadline - time.monotonic()))
        theirs, _ = far.communicate(timeout=max(1, deadline - time.monotonic()))
    finally:
        for process in (near, far):
            if process.poll() is None:
                process.kill()
                process.wait()
    ours, theirs = ours.strip(), theirs.strip()
    if near.returncode or far.returncode or len(ours) != 64 or ours != theirs:
        raise ValueError(f"stopped off-box replica sha256 {theirs or 'unavailable'} differs from the stopped database {ours or 'unavailable'}; candidate not installed")
    run.step("hard-backup-sha256", remote=f"{host}:{replica}", sha256=ours, masked="page-1 change counter and version bytes", seconds=round(time.monotonic() - started, 3))
    return ours

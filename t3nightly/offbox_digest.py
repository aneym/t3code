import re
import shlex
import subprocess
import sys
import time

from .install_sqlite_sync import SSH

CONTENT_PY = ("import hashlib,signal,sys\n"
              "signal.alarm(int(sys.argv[2]))\n"
              "h=hashlib.sha256()\n"
              "with open(sys.argv[1],'rb') as f:\n"
              " b=bytearray(f.read(100)); b[24:28]=bytes(4); b[92:100]=bytes(8); h.update(b)\n"
              " for c in iter(lambda: f.read(1<<20), b''): h.update(c)\n"
              "print(h.hexdigest())")
CHECKPOINT_PY = ("import signal,sqlite3,sys\n"
                 "signal.alarm(int(sys.argv[2]))\n"
                 "c=sqlite3.connect(sys.argv[1],timeout=30,isolation_level=None)\n"
                 "busy=c.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]\n"
                 "c.close()\n"
                 "sys.exit(3 if busy else 0)")
DIGEST = re.compile(r"[0-9a-f]{64}")


def valid(value):
    return isinstance(value, str) and DIGEST.fullmatch(value) is not None


def remaining(deadline):
    return max(1, int(deadline - time.monotonic()))


def checkpoint(source, deadline):
    seconds = remaining(deadline)
    try:
        result = subprocess.run([sys.executable, "-I", "-c", CHECKPOINT_PY, str(source), str(seconds)], capture_output=True, text=True, timeout=seconds + 5, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError("stopped database checkpoint exceeded the stop window; candidate not installed") from error
    if result.returncode:
        raise ValueError(f"stopped database checkpoint failed ({result.returncode}): {result.stderr.strip()[-200:]}; candidate not installed")


def compare(run, host, replica, source, deadline):
    started = time.monotonic()
    seconds = remaining(deadline)
    processes = []
    try:
        processes.append(subprocess.Popen([sys.executable, "-I", "-c", CONTENT_PY, str(source), str(seconds)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        processes.append(subprocess.Popen([str(SSH), host, f"python3 -I -c {shlex.quote(CONTENT_PY)} {shlex.quote(str(replica))} {seconds}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        ours, theirs = (process.communicate(timeout=remaining(deadline) + 5)[0].strip() for process in processes)
    except subprocess.TimeoutExpired as error:
        raise ValueError("stopped off-box sha256 exceeded the stop window; candidate not installed") from error
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    near, far = processes
    if near.returncode or far.returncode or not valid(ours) or ours != theirs:
        raise ValueError(f"stopped off-box replica sha256 {theirs or 'unavailable'} differs from the stopped database {ours or 'unavailable'}; candidate not installed")
    run.step("hard-backup-sha256", remote=f"{host}:{replica}", sha256=ours, masked="page-1 change counter and version bytes", seconds=round(time.monotonic() - started, 3))
    return ours

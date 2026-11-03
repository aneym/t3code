REMOTE = r'''
import json
import os
import pathlib
import select
import signal
import subprocess
import sys
import time

words, timeout, receipt = json.loads(sys.argv[1]), float(sys.argv[2]), pathlib.Path(sys.argv[3])
process = subprocess.Popen(words, stdin=subprocess.DEVNULL, start_new_session=True)
receipt.write_text(json.dumps({"pid": process.pid, "pgid": process.pid}))
def stop():
    for sig, grace in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        try:
            process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            continue
    process.wait()
def terminate(signum, frame):
    raise InterruptedError("remote supervisor terminated")
signal.signal(signal.SIGTERM, terminate)
deadline = time.monotonic() + timeout
try:
    while process.poll() is None:
        if time.monotonic() >= deadline:
            stop()
            sys.exit(124)
        if select.select([sys.stdin], [], [], 0.2)[0] and not sys.stdin.buffer.read(1):
            stop()
            sys.exit(143)
    code = process.returncode
    stop()
    sys.exit(code)
except (InterruptedError, KeyboardInterrupt):
    stop()
    sys.exit(143)
finally:
    receipt.unlink(missing_ok=True)
'''

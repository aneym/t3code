import json


LOCK = r'''
import fcntl
import json
import os
import pathlib
import signal
import subprocess
import sys

store, exclusive, words = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
path = pathlib.Path(store + ".lock")
path.parent.mkdir(parents=True, exist_ok=True)
handle = path.open("a")
try:
    fcntl.flock(handle, (fcntl.LOCK_EX | fcntl.LOCK_NB) if exclusive else fcntl.LOCK_SH)
except BlockingIOError:
    print(json.dumps({"store": store, "state": "busy"}), flush=True)
    sys.exit(75)
if sys.argv[4]:
    os.chdir(sys.argv[4])
process = subprocess.Popen(words)
signal.signal(signal.SIGTERM, lambda signum, frame: None)
sys.exit(process.wait())
'''


def locked(store, words, *, exclusive=False, cwd=None):
    return ["python3", "-c", LOCK, store, json.dumps(exclusive), json.dumps(words), str(cwd or "")]

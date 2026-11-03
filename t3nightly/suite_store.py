import json
import tempfile
from pathlib import Path

from .suite_environment import isolated
from .suite_reaper import reap
from .suite_worker import HOSTS, execute
from .suite_store_lock import locked

SIZE = r'''
import json
import os
import sys
size = 0
for root, dirs, files in os.walk(sys.argv[1]):
    for name in files:
        try:
            size += os.lstat(os.path.join(root, name)).st_blocks * 512
        except FileNotFoundError:
            pass
print(json.dumps({"bytes": size}))
'''


def prune_store(host, log):
    repo, root = HOSTS[host]
    store = str(Path(root) / ".advisory-pnpm-store")
    home = str(Path(root) / ".advisory-store-maintenance")
    words = isolated(home, ["pnpm", f"--config.store-dir={store}", "store", "prune"],
                     host=host, toolchain_root=repo)
    code = execute(host, locked(store, words, exclusive=True), log, 120)
    if code == 75:
        return {"host": host, "path": store, "pruneExit": code, "state": "busy", "bytes": None}
    with tempfile.TemporaryFile(mode="w+") as output:
        measured = execute(host, ["python3", "-c", SIZE, store], output, 30)
        output.seek(0)
        size = json.loads(output.read()) if measured == 0 else {"bytes": None}
    return {"host": host, "path": store, "pruneExit": code, **size}


def maintain(root, hosts, log, *, dry_run=False):
    return {"reaper": reap(root, log, dry_run=dry_run),
            "stores": [] if dry_run else [prune_store(host, log) for host in sorted(set(hosts))]}

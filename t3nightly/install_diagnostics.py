import os
import sys
from pathlib import Path


def persist_memory_diagnostics(args):
    if sys.platform == "darwin":
        return
    dropin = Path(args.systemd_dropin).expanduser()
    dropin.mkdir(parents=True, exist_ok=True)
    path = dropin / "30-memory-diagnostics.conf"
    path.write_text("[Service]\nEnvironment=T3CODE_MEMORY_DIAGNOSTICS=1\n")
    os.chmod(path, 0o600)

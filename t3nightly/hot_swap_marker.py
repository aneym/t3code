import json
import os
import tempfile
from pathlib import Path

from .install_provenance import file_digest


def write(run, version, measured, manifest):
    directory = run.runtime(version).parent
    if directory.is_symlink():
        from .rehearsal_storage import clone_tree, enabled
        from .install_runtime import exchange

        if not enabled(run.home):
            raise ValueError("hot-swap qualification refuses a non-isolated symlink runtime")
        with tempfile.TemporaryDirectory(prefix=".hot-swap-marker-", dir=directory.parent) as raw:
            staged = Path(raw) / version
            clone_tree(directory.resolve(), staged)
            exchange(staged, directory)
    marker = {"protocol": 1, "maintenance": False, "migration": False, "measuredStartupMs": measured, "candidateDigest": manifest["digest"], "runtimeDigest": file_digest(directory / "t3")}
    temporary = directory / ".hot-swap-next"
    temporary.write_text(json.dumps(marker) + "\n")
    os.replace(temporary, directory / "hot-swap.json")
    return marker

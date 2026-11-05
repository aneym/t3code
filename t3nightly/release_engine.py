import json
import shlex
import subprocess
from pathlib import Path

from .release_manifest import engine_identity, load
from .remote_shell import ssh_argv


def require_engine(manifest, engine=Path(__file__).resolve().parent):
    expected = load(manifest)["engine"]["digest"]
    actual = engine_identity(engine)["digest"]
    if actual != expected:
        raise ValueError(f"engine digest mismatch: candidate.json engine.digest={expected}, engine {engine} digest={actual}; use the frozen candidate engine")
    return expected


def require_remote_engine(manifest, remote_tools, linux_host):
    expected = load(manifest)["engine"]["digest"]
    script = "import json,sys; from pathlib import Path; engine=Path(sys.argv[1]).resolve(); sys.path.insert(0,str(engine.parent)); from t3nightly.release_manifest import engine_identity; print(json.dumps(engine_identity(engine)['digest']))"
    result = subprocess.run([*ssh_argv(linux_host, '-oConnectTimeout=5'),
                             shlex.join(["python3", "-c", script, remote_tools])], capture_output=True, text=True, timeout=20, check=False)
    if result.returncode:
        raise ValueError(f"cannot verify --remote-tools engine digest on {linux_host}: candidate.json engine.digest={expected}, remote digest=unavailable (exit {result.returncode})")
    actual = json.loads(result.stdout)
    if actual != expected:
        raise ValueError(f"remote engine digest mismatch: candidate.json engine.digest={expected}, --remote-tools {remote_tools} digest={actual}; use the frozen candidate engine")
    return expected

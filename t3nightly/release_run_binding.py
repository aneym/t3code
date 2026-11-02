import json
import os
import shlex
import subprocess
import sys
import tempfile
import uuid

from .release_targets import LINUX_TARGETS


REMOTE_BIND = '''
import fcntl, json, os, sys, tempfile
from pathlib import Path
value = json.load(sys.stdin)
root = Path(value.pop("remoteRun"))
root.mkdir(parents=True, exist_ok=True)
with (root / ".coordinator.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    binding = root / "coordinator-identity.json"
    if binding.exists():
        if json.loads(binding.read_text()) != value:
            sys.exit("remote run belongs to a different coordinator identity")
    elif any(path.name != ".coordinator.lock" and not path.name.startswith(".coordinator-identity-") for path in root.iterdir()):
        sys.exit("remote run already holds state without this coordinator identity")
    else:
        try:
            fd, temporary = tempfile.mkstemp(dir=root, prefix=".coordinator-identity-")
        except OSError as error:
            print(f"coordinator identity filesystem error creating a temp file in {root}: {error}", file=sys.stderr)
            sys.exit(74)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(value, handle, sort_keys=True)
            os.link(temporary, binding)
        except FileExistsError:
            if json.loads(binding.read_text()) != value:
                sys.exit("remote run belongs to a different coordinator identity")
        except OSError as error:
            print(f"coordinator identity filesystem error linking {temporary} to {binding}: {error}", file=sys.stderr)
            sys.exit(74)
        finally:
            os.unlink(temporary)
'''


def bind_remote_runs(args):
    if args.dry_run:
        return {}
    args.run.mkdir(parents=True, exist_ok=True)
    path = args.run / "coordinator-identity.json"
    fd, temporary = tempfile.mkstemp(dir=args.run, prefix=".coordinator-identity-")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump({"id": uuid.uuid4().hex, "run": str(args.run)}, handle, sort_keys=True)
        os.link(temporary, path)
    except FileExistsError:
        pass
    except OSError as error:
        raise RuntimeError(f"coordinator identity filesystem error linking {temporary} to {path}: {error}") from error
    finally:
        os.unlink(temporary)
    value = {"coordinator": json.loads(path.read_text()), "version": args.version, "remoteRun": args.remote_run}
    unbound = {}
    for host, address in LINUX_TARGETS.items():
        if host == getattr(args, "defer_host", None):
            continue
        try:
            result = subprocess.run(["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", address,
                                     shlex.join(["python3", "-c", REMOTE_BIND])],
                                    input=json.dumps(value), capture_output=True, text=True, timeout=20, check=False)
        except subprocess.TimeoutExpired:
            unbound[host] = "remote run binding timed out"
            print(f"release: warning: {host} unreachable for remote run binding", file=sys.stderr)
            continue
        if result.returncode == 255:
            unbound[host] = f"remote run binding unreachable: {result.stderr.strip()[-300:]}"
            print(f"release: warning: {host} unreachable for remote run binding", file=sys.stderr)
            continue
        if result.returncode == 74:
            raise RuntimeError(f"{host}: {result.stderr.strip()}")
        if result.returncode:
            raise ValueError(f"{host}: refusing --remote-run {args.remote_run}: {result.stderr.strip()}; "
                             "resume with the original --run or choose a fresh --remote-run")
    return unbound
